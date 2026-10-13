import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_MANIFEST_FILE,
  WORKFLOW_ASSET_KIND,
  asClientInstanceId,
  dataStoreOperationName
} from "@vivd-catalyst/core";
import { eventually, required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance, getTestJobs, type TestInstance } from "./support/test-instance";
import { runSchema } from "./support/workflow-instance";

// The rights a Workflow's steps need on a Data Store, given to its service principal through
// `permissions.grant` on an assembled instance with both modules on: the stores are published
// from their folders, the Workflows are written and published as assets, the runs are started
// over HTTP and executed by the instance's jobs. No grant row is written to the store.

const KEY_VARIABLE = "DATA_STORE_TEST_KEY";
const clientInstanceId = asClientInstanceId("demo-local");
const RUNNER = "bookkeeper";
const STORES = ["findings", "ledger"] as const;
type StoreName = (typeof STORES)[number];

const migration = {
  path: "migrations/0001_init.sql",
  text: "create table findings (client_id text not null, rule_id text not null);"
};
const finding = { client_id: "client-7", rule_id: "vat-rate" };

const idSchema = z.object({ id: z.string() }).loose();
const errorSchema = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()).optional() })
});

/** A Workflow of one step that adds one row to the store. */
function storing(store: StoreName) {
  return {
    id: `store-in-${store}`,
    name: `Store a finding in ${store}`,
    runAs: RUNNER,
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "store",
        name: "Store the finding",
        type: "operation",
        operation: dataStoreOperationName(store, "insert"),
        input: { table: { value: "findings" }, rows: { value: [finding] } }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { inserted: { ref: { step: "store", path: "inserted" } } }
      }
    ]
  };
}

describe("a Data Store right given to the service principal of a Workflow", () => {
  const roots: string[] = [];
  const started: TestInstance[] = [];

  afterEach(async () => {
    // Databases and roles are the cluster's, which other suites share: every one a test made
    // is removed by name, once the instance that reaches them is closed.
    await Promise.all(started.splice(0).map((instance) => instance.close()));
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      const records = await sql<
        { database_name: string; app_role: string; migration_role: string }[]
      >`select database_name, app_role, migration_role from data_stores`;
      for (const record of records) {
        await sql.unsafe(`drop database if exists "${record.database_name}" with (force)`);
        await sql.unsafe(`drop role if exists "${record.app_role}"`);
        await sql.unsafe(`drop role if exists "${record.migration_role}"`);
      }
    } finally {
      await sql.end();
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  /** The instance with two published stores, the principal and a published Workflow per store. */
  async function world() {
    const root = await mkdtemp(join(tmpdir(), "workflow-data-store-"));
    roots.push(root);
    const base = createTestConfig();
    const api = await createTestInstance({
      config: parseClientInstanceConfig({
        ...base,
        modules: {
          assetManagement: { enabled: true },
          dataStores: { enabled: true },
          workflows: { enabled: true }
        },
        // Nobody is present in a run to confirm a change: this instance lets changes run.
        policy: { defaults: { reading: "allow", changing: "allow" } },
        secretStore: { keys: [{ id: "k1", ref: KEY_VARIABLE }] },
        infrastructure: {
          ...base.infrastructure,
          objectStorage: {
            ...base.infrastructure.objectStorage,
            files: { provider: "filesystem", root }
          }
        }
      }),
      env: { [KEY_VARIABLE]: randomBytes(32).toString("base64") },
      tools: []
    });
    started.push(api);
    const ok = async (...call: Parameters<TestInstance["call"]>) => {
      const response = await api.call(...call);
      expect(response.statusCode, `${call[0]}: ${response.body}`).toBe(200);
      return response;
    };

    const { principal } = z.object({ principal: idSchema }).parse(
      (
        await ok("service_principals.create", {
          payload: { name: RUNNER, displayLabel: "Bookkeeper" }
        })
      ).json()
    );
    for (const store of STORES) {
      const params = { kind: DATA_STORE_ASSET_KIND, name: store };
      const files = [
        { path: DATA_STORE_MANIFEST_FILE, text: `id: ${store}\nname: ${store}\n` },
        migration
      ];
      await ok("assets.put", { params, payload: { files, expectedRevision: null } });
      await ok("assets.publish", { params, payload: { revision: 1 } });
    }
    const jobs = getTestJobs(api);
    const storeIds = await eventually(async () => {
      await jobs.runDue();
      const records = await Promise.all(
        STORES.map((name) => api.stores.dataStores.findDataStoreByName({ clientInstanceId, name }))
      );
      for (const record of records) expect(record).toMatchObject({ status: "ready", level: 1 });
      return { findings: required(records[0]).id, ledger: required(records[1]).id };
    });
    for (const store of STORES) {
      const manifest = storing(store);
      const params = { kind: WORKFLOW_ASSET_KIND, name: manifest.id };
      await ok("assets.put", {
        params,
        payload: { config: { name: manifest.id, manifest }, expectedRevision: null }
      });
      await ok("assets.publish", { params, payload: { revision: 1 } });
    }

    /** Starts the Workflow of the store and runs the jobs until its run has ended. */
    const run = async (store: StoreName) => {
      const response = await ok("workflows.start", {
        params: { workflow: storing(store).id },
        payload: { input: {} }
      });
      const { id } = runSchema.parse(response.json());
      for (let pass = 0; pass < 20; pass++) {
        await jobs.runDue();
        const read = runSchema.parse(
          (await ok("workflows.get_run", { params: { runId: id } })).json()
        );
        if (!["queued", "running", "waiting"].includes(read.status)) return read;
      }
      throw new Error("The Workflow Run did not end");
    };
    const rows = async (store: StoreName) => {
      const response = await ok("data_stores.query", {
        params: { store },
        payload: { sql: "select count(*)::integer as count from findings" }
      });
      return z
        .object({ rows: z.array(z.object({ count: z.number() })) })
        .parse(response.json())
        .rows.map((row) => row.count);
    };
    const grant = (action: string, scope: Record<string, unknown>) =>
      api.call("permissions.grant", {
        payload: { holderKind: "service_principal", holderId: principal.id, action, ...scope }
      });
    return { api, ok, principal, storeIds, run, rows, grant };
  }

  it("lets a step add rows to the one store its principal was given, and to no other", async () => {
    const w = await world();
    const refused = { status: "failed", error: { code: "FORBIDDEN", action: "data_store.insert" } };
    // The starter is a superadmin, and the run has the principal's rights alone: none yet.
    expect(await w.run("findings")).toMatchObject(refused);
    expect(await w.rows("findings")).toEqual([0]);

    const written = await w.grant(DATA_STORE_ACTIONS.insert, {
      scopeKind: "asset",
      scopeId: w.storeIds.findings
    });
    expect(written.statusCode, written.body).toBe(200);
    const grantId = idSchema.parse(written.json()).id;

    const stored = await w.run("findings");
    expect(stored.error).toBeUndefined();
    expect(stored).toMatchObject({ status: "done", principal: { id: w.principal.id } });
    expect(JSON.parse(stored.outputPreview?.text ?? "null")).toEqual({ inserted: 1 });
    expect(await w.rows("findings")).toEqual([1]);
    // The same step on the other store is refused with the right named, and adds nothing.
    expect(await w.run("ledger")).toMatchObject(refused);
    expect(await w.rows("ledger")).toEqual([0]);

    // Without the row the next run is refused again.
    await w.ok("permissions.revoke", { params: { grantId } });
    expect(await w.run("findings")).toMatchObject(refused);
    expect(await w.rows("findings")).toEqual([1]);
  }, 120_000);

  it("gives a principal the three rights on rows, each on one store, and none over its definition", async () => {
    const w = await world();
    const onFindings = { scopeKind: "asset", scopeId: w.storeIds.findings };
    const reasonOf = (response: Awaited<ReturnType<TestInstance["call"]>>) => {
      expect(response.statusCode, response.body).toBe(422);
      return errorSchema.parse(response.json()).error.details?.reason;
    };

    for (const action of [
      DATA_STORE_ACTIONS.write,
      DATA_STORE_ACTIONS.publish,
      DATA_STORE_ACTIONS.delete
    ]) {
      expect(reasonOf(await w.grant(action, onFindings)), action).toBe(
        "action_not_grantable_to_principal"
      );
    }
    for (const scope of [
      { scopeKind: "instance" },
      // A Workflow is no Data Store.
      {
        scopeKind: "asset",
        scopeId: required(
          await w.api.stores.configAssets.getConfigAsset({
            clientInstanceId,
            kind: WORKFLOW_ASSET_KIND,
            name: storing("findings").id
          })
        ).id
      }
    ]) {
      expect(reasonOf(await w.grant(DATA_STORE_ACTIONS.insert, scope))).toBe("invalid_scope");
    }
    for (const action of [
      DATA_STORE_ACTIONS.read,
      DATA_STORE_ACTIONS.insert,
      DATA_STORE_ACTIONS.execute
    ]) {
      const written = await w.grant(action, onFindings);
      expect(written.statusCode, `${action}: ${written.body}`).toBe(200);
    }
    const held = await w.api.stores.access.listGrants({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: w.principal.id
    });
    expect(held.map((row) => [row.action, row.scopeKind, row.scopeId]).sort()).toEqual(
      ["data_store.execute", "data_store.insert", "data_store.read"].map((action) => [
        action,
        "asset",
        w.storeIds.findings
      ])
    );
  }, 120_000);
});
