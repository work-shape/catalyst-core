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
  dataStoreOperationName,
  type CentralPolicySetting
} from "@vivd-catalyst/core";
import { workflowScheduleJobKind } from "@vivd-catalyst/workflows";
import { eventually, required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance, getTestJobs, type TestInstance } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";
import { runSchema } from "./support/workflow-instance";

// WF-AUTO-1: a run of a published Workflow revision performs its changing operations. The
// publish was the confirmation of their `confirm`, so a step adds rows to a Data Store under the
// instance's default policy, from a schedule and from a manual start, and the run of the call
// says why nobody was asked. A `deny`, a guardrail that asks for an approval and the grants of
// the principal still stop the call. An assembled instance: the store and the Workflows are
// written and published as assets, the runs are executed by the instance's jobs.

const KEY_VARIABLE = "DATA_STORE_TEST_KEY";
const clientInstanceId = asClientInstanceId("demo-local");
const RUNNER = "bookkeeper";
const STORE = "findings";
const INSERT = dataStoreOperationName(STORE, "insert");

const finding = { client_id: "client-7", rule_id: "vat-rate" };
const idSchema = z.object({ id: z.string() }).loose();
const revisionSchema = z.looseObject({ revision: z.number() });

/** A Workflow of one step that adds one row to the store, started by the trigger given. */
function storing(id: string, trigger: Record<string, unknown>) {
  return {
    id,
    name: `Store a finding (${id})`,
    runAs: RUNNER,
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [trigger] },
      {
        id: "store",
        name: "Store the finding",
        type: "operation",
        operation: INSERT,
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

const BY_HAND = storing("store-by-hand", { kind: "manual" });
const ON_SCHEDULE = storing("store-on-schedule", { kind: "schedule", cron: "* * * * *" });

describe("a run of a published Workflow revision", () => {
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

  /**
   * The instance with the published store, the principal with `data_store.insert` on it and
   * both Workflows published, under the instance's default policy for changes, `confirm`.
   * `settings` are the policy settings of the instance, which a test may change meanwhile.
   */
  async function world() {
    const settings: CentralPolicySetting[] = [];
    const root = await mkdtemp(join(tmpdir(), "workflow-run-through-"));
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
      tools: [],
      operations: { centralPolicySettings: () => settings }
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
    const storeParams = { kind: DATA_STORE_ASSET_KIND, name: STORE };
    await ok("assets.put", {
      params: storeParams,
      payload: {
        files: [
          { path: DATA_STORE_MANIFEST_FILE, text: `id: ${STORE}\nname: ${STORE}\n` },
          {
            path: "migrations/0001_init.sql",
            text: "create table findings (client_id text not null, rule_id text not null);"
          }
        ],
        expectedRevision: null
      }
    });
    await ok("assets.publish", { params: storeParams, payload: { revision: 1 } });
    const jobs = getTestJobs(api);
    const storeId = await eventually(async () => {
      await jobs.runDue();
      const record = await api.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: STORE
      });
      expect(record).toMatchObject({ status: "ready", level: 1 });
      return required(record).id;
    });
    await ok("permissions.grant", {
      payload: {
        holderKind: "service_principal",
        holderId: principal.id,
        action: DATA_STORE_ACTIONS.insert,
        scopeKind: "asset",
        scopeId: storeId
      }
    });
    for (const manifest of [BY_HAND, ON_SCHEDULE]) {
      const params = { kind: WORKFLOW_ASSET_KIND, name: manifest.id };
      await ok("assets.put", {
        params,
        payload: { config: { name: manifest.id, manifest }, expectedRevision: null }
      });
      await ok("assets.publish", { params, payload: { revision: 1 } });
    }

    /** Runs the jobs until the run has ended, and answers it. */
    const finish = async (runId: string) => {
      for (let pass = 0; pass < 20; pass++) {
        await jobs.runDue();
        const read = runSchema.parse(
          (await ok("workflows.get_run", { params: { runId } })).json()
        );
        if (!["queued", "running", "waiting"].includes(read.status)) return read;
      }
      throw new Error("The Workflow Run did not end");
    };
    /** Starts the published revision of the manual Workflow by hand. */
    const runByHand = async () => {
      const response = await ok("workflows.start", {
        params: { workflow: BY_HAND.id },
        payload: { input: {} }
      });
      return finish(runSchema.parse(response.json()).id);
    };
    /**
     * Lets the due time of the schedule come now: the queued job's time is moved to the
     * database's present, as a worker claims a job once the database's clock reached it.
     */
    const runOnSchedule = async () => {
      const moved = await withTestSql(
        (sql) => sql`
          update platform_jobs set run_after = now()
          where client_instance_id = ${clientInstanceId} and kind = ${workflowScheduleJobKind.kind}
            and subject = ${ON_SCHEDULE.id} and status = 'queued'
          returning id`
      );
      expect(moved).toHaveLength(1);
      await jobs.runDue();
      const [run, ...more] = await api.stores.workflowRuns.listRuns({
        clientInstanceId,
        workflow: ON_SCHEDULE.id
      });
      expect(more).toEqual([]);
      expect(run).toMatchObject({ trigger: "schedule" });
      return finish(required(run).id);
    };
    const rows = async () => {
      const response = await ok("data_stores.query", {
        params: { store: STORE },
        payload: { sql: "select count(*)::integer as count from findings" }
      });
      return z
        .object({ rows: z.array(z.object({ count: z.number() })) })
        .parse(response.json())
        .rows.map((row) => row.count);
    };
    /** The Operation Runs of the insert that steps of Workflow Runs made, oldest first. */
    const insertRuns = async () =>
      (
        await api.stores.operationRuns.list({
          clientInstanceId,
          filters: { operation: INSERT, originKind: "workflow" },
          page: { limit: 50 }
        })
      ).reverse();
    return { api, ok, settings, principal, runByHand, runOnSchedule, rows, insertRuns };
  }

  it("adds rows under the default 'confirm', from a schedule and by hand, and says the publish confirmed it", async () => {
    const w = await world();

    const scheduled = await w.runOnSchedule();
    expect(scheduled.error).toBeUndefined();
    expect(scheduled).toMatchObject({ status: "done", principal: { id: w.principal.id } });
    expect(JSON.parse(scheduled.outputPreview?.text ?? "null")).toEqual({ inserted: 1 });

    const byHand = await w.runByHand();
    expect(byHand.error).toBeUndefined();
    expect(byHand).toMatchObject({ status: "done" });
    expect(await w.rows()).toEqual([2]);

    // Each call is an Operation Run of the principal whose decision says why nobody was asked.
    const runs = await w.insertRuns();
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toMatchObject({
        status: "done",
        actor: { kind: "service_principal", id: w.principal.id },
        decision: { mode: "direct", reason: "workflow_publish" }
      });
    }
    // Its audit row says it too, and holds nothing of the rows.
    const completed = await withTestSql(
      (sql) => sql<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit_events
        where client_instance_id = ${clientInstanceId} and type = 'operation.completed'
          and metadata->>'operation' = ${INSERT}
        order by created_at`
    );
    expect(completed.map((event) => event.metadata)).toEqual([
      expect.objectContaining({ decisionReason: "workflow_publish", origin: "workflow" }),
      expect.objectContaining({ decisionReason: "workflow_publish", origin: "workflow" })
    ]);
    expect(JSON.stringify(completed)).not.toContain("client-7");
  }, 120_000);

  it("is refused where the policy of the operation is 'deny', and adds nothing", async () => {
    const w = await world();
    w.settings.push({ operation: INSERT, value: "deny" });
    const run = await w.runByHand();
    expect(run).toMatchObject({ status: "failed", error: { code: "POLICY_DENIED" } });
    expect(run.error?.message).toBe(`The instance's policy does not allow '${INSERT}' from here`);
    expect(await w.rows()).toEqual([0]);
  }, 120_000);

  it("fails the step where a published guardrail asks for an approval, and names the guardrail", async () => {
    const w = await world();
    const params = { kind: "guardrail", name: "findings-need-approval" };
    const written = await w.ok("assets.put", {
      params,
      payload: {
        config: {
          name: "findings-need-approval",
          displayName: "Findings are approved",
          on: "operation.before_call",
          filter: { operation: INSERT },
          check: { kind: "pattern", pattern: "." },
          outcome: "require_approval"
        },
        expectedRevision: null
      }
    });
    const { revision } = revisionSchema.parse(written.json());
    await w.ok("assets.publish", { params, payload: { revision } });

    const run = await w.runByHand();
    expect(run).toMatchObject({ status: "failed", error: { code: "POLICY_DENIED" } });
    expect(run.error?.message).toBe(
      `The guardrail 'Findings are approved' asks for another person's approval of '${INSERT}', and this call cannot wait for one. In a Workflow, put an approval step before the step that calls it.`
    );
    expect(await w.rows()).toEqual([0]);
    const [refused] = await w.insertRuns();
    expect(refused).toMatchObject({
      status: "denied",
      denial: {
        kind: "policy",
        operation: INSERT,
        reason: "approval_unavailable",
        guardrail: { id: "findings-need-approval", label: "Findings are approved" }
      }
    });
  }, 120_000);
});
