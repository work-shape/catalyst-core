import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_JOB_KINDS,
  DATA_STORE_MANIFEST_FILE,
  DATA_STORE_OPERATION_SCOPES,
  DATA_STORE_OPERATION_VERBS,
  asClientInstanceId,
  asUserId,
  createPlatformId,
  dataStoreOperationName,
  type AuthenticatedUser,
  type DataStoreOperationVerb,
  type DataStoreRecord,
  type JsonObject,
  type UserRole,
  type WorkflowRunPrincipal
} from "@vivd-catalyst/core";
import { runOperation } from "@vivd-catalyst/tool-execution";
import { eventually, required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { fileTestDatabaseUrl } from "./support/test-database";
import {
  createTestInstance,
  getTestExecution,
  getTestJobs,
  type TestInstance
} from "./support/test-instance";

// A Data Store through the assembled instance: its folder is written and published with the
// asset operations, its jobs are the module's, and its rows are reached through the call
// path, with the caller's right, one run per call and audit rows without a value.

const KEY_VARIABLE = "DATA_STORE_TEST_KEY";
const clientInstanceId = asClientInstanceId("demo-local");

const files = [
  {
    path: DATA_STORE_MANIFEST_FILE,
    text: "id: findings\nname: Findings\ndescription: What the monthly check of bookings found.\n"
  },
  {
    path: "migrations/0001_init.sql",
    text: `create table findings (
      run_id text not null,
      client_id text not null,
      rule_id text not null,
      revision integer not null,
      severity text not null,
      amount numeric(14, 2),
      details jsonb not null default '{}'::jsonb
    );`
  }
];
const finding: JsonObject = {
  run_id: "run-1",
  client_id: "client-secret-7",
  rule_id: "vat-rate",
  revision: 3,
  severity: "warning",
  amount: 119.5,
  details: { booking: 7 }
};

interface ErrorBody {
  error: { code: string; message: string; details?: { reason?: string; module?: string } };
}

describe("a Data Store on an assembled instance", () => {
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
   * One instance as its two processes see it: the API, which serves the asset operations and
   * the jobs, and the call path as an agent worker or a Workflow step reaches it. Both are
   * assembled from the same config on the same database.
   */
  async function start(dataStores: boolean): Promise<World> {
    const root = await mkdtemp(join(tmpdir(), "data-store-test-"));
    roots.push(root);
    const base = createTestConfig();
    const config = parseClientInstanceConfig({
      ...base,
      modules: { assetManagement: { enabled: true }, dataStores: { enabled: dataStores } },
      secretStore: { keys: [{ id: "k1", ref: KEY_VARIABLE }] },
      infrastructure: {
        ...base.infrastructure,
        objectStorage: {
          ...base.infrastructure.objectStorage,
          files: { provider: "filesystem", root }
        }
      }
    });
    const input = {
      config,
      env: { [KEY_VARIABLE]: randomBytes(32).toString("base64") },
      tools: []
    };
    const api = await createTestInstance(input);
    started.push(api);
    const calls = await createTestInstance({ execution: input });
    started.push(calls);
    return { api, stores: api.stores, execution: getTestExecution(calls) };
  }

  interface World {
    api: TestInstance;
    stores: TestInstance["stores"];
    execution: ReturnType<typeof getTestExecution>;
  }

  const put = ({ api }: World, storeFiles = files, expectedRevision: number | null = null) =>
    api.call("assets.put", {
      params: { kind: DATA_STORE_ASSET_KIND, name: "findings" },
      payload: { files: storeFiles, expectedRevision }
    });

  const publish = ({ api }: World, revision: number) =>
    api.call("assets.publish", {
      params: { kind: DATA_STORE_ASSET_KIND, name: "findings" },
      payload: { revision }
    });

  /** Writes the folder as revision 1 and publishes it. A refusal fails the test where it happens. */
  async function publishStore(world: World): Promise<DataStoreRecord> {
    expect((await put(world)).statusCode).toBe(200);
    expect((await publish(world, 1)).statusCode).toBe(200);
    return settle(world, 1);
  }

  async function recordOf({ stores }: World): Promise<DataStoreRecord> {
    return required(
      await stores.dataStores.findDataStoreByName({ clientInstanceId, name: "findings" })
    );
  }

  /** Runs the jobs of the API process until the store is at the level. */
  function settle(world: World, level: number): Promise<DataStoreRecord> {
    const jobs = getTestJobs(world.api);
    return eventually(async () => {
      await jobs.runDue();
      const record = await recordOf(world);
      expect(record).toMatchObject({ status: "ready", level });
      return record;
    });
  }

  async function person({ stores }: World, name: string, roles: UserRole[]) {
    const user: AuthenticatedUser = await stores.users.resolveUserIdentity({
      clientInstanceId,
      authSource: "test",
      externalUserId: name,
      displayLabel: name,
      roles,
      permissionRefs: [],
      permissions: [],
      correlationId: "test"
    });
    return user;
  }

  function call(
    world: World,
    actor: AuthenticatedUser,
    verb: DataStoreOperationVerb,
    input: unknown,
    idempotencyKey?: string
  ) {
    return runOperation(
      {
        operation: dataStoreOperationName("findings", verb),
        effect: verb === "insert" || verb === "load" ? "changing" : "reading",
        input,
        actor,
        origin: { kind: "user" },
        correlationId: "corr_data_store",
        ...(idempotencyKey ? { idempotencyKey } : {})
      },
      world.execution.operationCalls.deps
    );
  }

  /** One call of a store's rows over HTTP, as the instance's administrator. */
  const overHttp = (
    { api }: World,
    operation:
      | "data_stores.query"
      | "data_stores.insert"
      | "data_stores.describe"
      | "data_stores.preview_rows",
    input: {
      payload?: JsonObject;
      query?: Record<string, string>;
      headers?: Record<string, string>;
    }
  ) => api.call(operation, { params: { store: "findings" }, ...input });

  const startedKinds = (world: World) => ({
    jobs: world.execution.modulesStarted.jobHandlers.map((handler) => handler.kind.kind),
    schedules: world.execution.modulesStarted.schedules.map((schedule) => schedule.kind.kind),
    retries: world.execution.modulesStarted.jobRetries.map((retry) => retry.kind.kind)
  });

  it("has the size ceiling and the pool cap of a store in release config, with the spec's defaults", () => {
    expect(parseClientInstanceConfig(createTestConfig()).dataStores).toEqual({
      sizeLimit: "5GB",
      poolMaxConnections: 5
    });
  });

  // Needs no right: the switch refuses before the caller's rights are known.
  it("has no kind, operation, route, job or tool while the module is off", async () => {
    const instance = await start(false);

    const written = await put(instance);
    const queried = await overHttp(instance, "data_stores.query", { payload: { sql: "select 1" } });

    expect(written.statusCode).toBe(404);
    expect(written.json<ErrorBody>().error.details).toMatchObject({
      reason: "module_off",
      module: "dataStores"
    });
    // A module that is off builds nothing, its routes among it: the address is not there.
    expect(queried.statusCode).toBe(404);
    expect(instance.execution.configAssets.kinds.get(DATA_STORE_ASSET_KIND)).toBeUndefined();
    expect(startedKinds(instance)).toEqual({ jobs: [], schedules: [], retries: [] });
    expect(instance.execution.modulesStarted.dataToolSources).toEqual([]);
    expect(
      await instance.execution.operationCalls.registry.resolve(
        dataStoreOperationName("findings", "query")
      )
    ).toBeUndefined();
    expect(
      await instance.stores.dataStores.listDataStores({ clientInstanceId, limit: 10 })
    ).toEqual([]);
  });

  it("brings the kind with the contract's rights, the jobs with their retries and the schedule while the module is on", async () => {
    const instance = await start(true);

    expect(instance.execution.configAssets.kinds.require(DATA_STORE_ASSET_KIND).actions).toEqual(
      DATA_STORE_ACTIONS
    );
    expect(startedKinds(instance)).toEqual({
      jobs: Object.values(DATA_STORE_JOB_KINDS),
      schedules: [DATA_STORE_JOB_KINDS.measureSize],
      // A scheduled measurement is not retried by hand: the next tick is its retry.
      retries: [DATA_STORE_JOB_KINDS.provision, DATA_STORE_JOB_KINDS.migrate]
    });
  });

  it("publishes a store from its folder, inserts findings and queries them over HTTP", async () => {
    const instance = await start(true);
    const record = await publishStore(instance);

    const inserted = await overHttp(instance, "data_stores.insert", {
      payload: { table: "findings", rows: [finding] }
    });
    const queried = await overHttp(instance, "data_stores.query", {
      payload: {
        sql: "select client_id, amount from findings where rule_id = $1",
        parameters: [{ type: "text", value: "vat-rate" }]
      }
    });

    expect(inserted.statusCode).toBe(200);
    expect(inserted.json()).toEqual({ table: "findings", inserted: 1, skipped: 0 });
    expect(queried.statusCode).toBe(200);
    expect(queried.json()).toEqual({
      columns: [
        { name: "client_id", type: "text", nativeType: "text" },
        { name: "amount", type: "number", nativeType: "numeric" }
      ],
      rows: [{ client_id: "client-secret-7", amount: "119.50" }],
      truncated: false
    });
    // Publishing made a database of its own, and the platform database reads as current.
    expect(record.location.database).toMatch(/^catalyst_ds_/u);
    expect(await instance.stores.readiness?.()).toMatchObject({ status: "ready" });
  });

  it("describes the tables of a store and previews the rows of one over HTTP", async () => {
    const instance = await start(true);
    await publishStore(instance);
    await overHttp(instance, "data_stores.insert", {
      payload: { table: "findings", rows: [finding] }
    });

    const described = await overHttp(instance, "data_stores.describe", {});
    const previewed = await overHttp(instance, "data_stores.preview_rows", {
      query: { table: "findings", limit: "5" }
    });

    expect(described.statusCode).toBe(200);
    expect(described.json()).toMatchObject({
      schemaLevel: 1,
      tables: [
        {
          name: "findings",
          columns: expect.arrayContaining([
            {
              name: "amount",
              type: "number",
              nativeType: "numeric(14,2)",
              nullable: true,
              primaryKey: false
            }
          ])
        }
      ]
    });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json()).toMatchObject({
      rows: [{ client_id: "client-secret-7", revision: 3 }],
      truncated: false
    });
  });

  it("records one run per call and audit rows that hold names and counts, never a value", async () => {
    const instance = await start(true);
    const admin = await person(instance, "user-1", ["user", "admin", "superadmin"]);
    const record = await publishStore(instance);

    await call(instance, admin, "insert", { table: "findings", rows: [finding] });
    await call(instance, admin, "query", {
      sql: "select client_id from findings where client_id = $1",
      parameters: ["client-secret-7"]
    });
    await overHttp(instance, "data_stores.preview_rows", { query: { table: "findings" } });

    const runs = (await instance.stores.operationRuns.list({ clientInstanceId })).filter((run) =>
      run.operation.startsWith("data_store")
    );
    expect(runs.map((run) => [run.operation, run.effect, run.status]).sort()).toEqual([
      ["data_store.findings.insert", "changing", "done"],
      ["data_store.findings.preview_rows", "reading", "done"],
      ["data_store.findings.query", "reading", "done"]
    ]);
    const audit = await instance.stores.audit.listAuditEvents({ clientInstanceId });
    const rowsOf = (operation: string) =>
      audit
        .filter((event) => event.metadata?.operation === operation)
        .map((event) => [event.type, event.subject, event.metadata?.action])
        .sort();
    const three = (subject: string, action?: string) => [
      ["operation.authorization_checked", subject, action],
      ["operation.completed", subject, undefined],
      ["operation.started", subject, undefined]
    ];
    expect(rowsOf("data_store.findings.insert")).toEqual(three(record.id, "data_store.insert"));
    expect(rowsOf("data_store.findings.query")).toEqual(three(record.id, "data_store.read"));
    // A call over HTTP is the store's own operation: one name per act, in the run and the trail.
    expect(rowsOf("data_store.findings.preview_rows")).toEqual(three(record.id, "data_store.read"));
    expect(
      audit.filter((event) => String(event.metadata?.operation).startsWith("data_stores."))
    ).toEqual([]);
    const kept = JSON.stringify({ runs, audit, record });
    expect(kept).not.toContain("client-secret-7");
    expect(kept).not.toContain("select client_id");
  });

  it("answers a repeated insert of one key with the first answer and adds nothing twice", async () => {
    const instance = await start(true);
    await publishStore(instance);
    const insert = () =>
      overHttp(instance, "data_stores.insert", {
        payload: { table: "findings", rows: [finding] },
        headers: { "idempotency-key": "month-2026-09" }
      });

    const first = await insert();
    const second = await insert();

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const counted = await overHttp(instance, "data_stores.query", {
      payload: { sql: "select count(*)::integer as count from findings" }
    });
    expect(counted.json()).toMatchObject({ rows: [{ count: 1 }] });
  });

  it("asks data_store.read to query, describe and preview and data_store.insert to insert, which data_store.write does not give", async () => {
    const instance = await start(true);
    const admin = await person(instance, "user-1", ["user", "admin", "superadmin"]);
    const principal = await person(instance, "workflow-principal", ["user"]);
    const record = await publishStore(instance);
    const grant = (action: string) =>
      instance.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: principal.id,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: record.id,
        grantedBy: asUserId(admin.id)
      });
    const outcome = async (verb: DataStoreOperationVerb, input: unknown) => {
      const { result } = await call(instance, principal, verb, input);
      return result.status === "denied" ? result.reason : result.status;
    };
    const denied = (action: string) => ({ kind: "forbidden", action, reason: "no_grant" });
    const insert = { table: "findings", rows: [finding] };
    const reads = [
      ["query", { sql: "select count(*)::integer as count from findings" }],
      ["describe", {}],
      ["preview_rows", { table: "findings" }]
    ] as const;

    for (const [verb, input] of reads) {
      expect(await outcome(verb, input), verb).toEqual(denied(DATA_STORE_ACTIONS.read));
    }
    await grant(DATA_STORE_ACTIONS.read);
    for (const [verb, input] of reads) expect(await outcome(verb, input), verb).toBe("done");

    // Who may change the definition may not add rows by that, and the other way round.
    await grant(DATA_STORE_ACTIONS.write);
    expect(await outcome("insert", insert)).toEqual(denied(DATA_STORE_ACTIONS.insert));
    await grant(DATA_STORE_ACTIONS.insert);
    expect(await outcome("insert", insert)).toBe("done");
  });

  it("runs the step of a Workflow Run as the run's service principal, by that principal's grants and no one else's", async () => {
    const instance = await start(true);
    // Whoever starts the run and publishes the Workflow holds every right; no call is theirs.
    const admin = await person(instance, "user-1", ["user", "admin", "superadmin"]);
    const record = await publishStore(instance);
    const principal = await instance.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      name: "monthly-check",
      displayLabel: "Monthly check",
      createdByUserId: asUserId(admin.id)
    });
    const workflowRunId = createPlatformId<"WorkflowRunId">("wfrun");
    const actor: WorkflowRunPrincipal = {
      kind: "service",
      id: principal.id,
      displayLabel: principal.displayLabel,
      permissionRefs: principal.permissionRefs,
      permissions: principal.permissions,
      clientInstanceId,
      authSource: "workflow",
      scopes: [],
      workflowRunId
    };
    const grant = (action: string) =>
      instance.stores.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: principal.id,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: record.id,
        grantedBy: asUserId(admin.id)
      });
    const step = async (verb: DataStoreOperationVerb, input: unknown, stepRunId: string) => {
      const outcome = await runOperation(
        {
          operation: dataStoreOperationName("findings", verb),
          effect: verb === "insert" || verb === "load" ? "changing" : "reading",
          input,
          actor,
          origin: { kind: "workflow", workflowRunId, stepRunId },
          correlationId: "corr_monthly_check",
          // The key of a step's changing call is the id of its step run.
          idempotencyKey: stepRunId
        },
        instance.execution.operationCalls.deps
      );
      return {
        ...outcome,
        answer: outcome.result.status === "denied" ? outcome.result.reason : outcome.result.status
      };
    };
    const denied = (action: string) => ({ kind: "forbidden", action, reason: "no_grant" });
    const insert = { table: "findings", rows: [finding], onConflict: "fail" };
    const count = { sql: "select count(*)::integer as count from findings" };
    const dataset = { $dataset: "ds_findings", rowCount: 1, bytes: 100 };

    expect((await step("query", count, "step_1")).answer).toEqual(denied(DATA_STORE_ACTIONS.read));
    expect((await step("insert", insert, "step_2")).answer).toEqual(
      denied(DATA_STORE_ACTIONS.insert)
    );

    await grant(DATA_STORE_ACTIONS.insert);
    const added = await step("insert", insert, "step_3");
    expect(added).toMatchObject({
      answer: "done",
      replayed: false,
      run: {
        effect: "changing",
        actor: { kind: "service_principal", id: principal.id },
        origin: { kind: "workflow", workflowRunId, stepRunId: "step_3" }
      }
    });
    // The step run that is tried again is answered what it was answered, and adds nothing.
    expect(await step("insert", insert, "step_3")).toMatchObject({
      answer: "done",
      replayed: true
    });
    // Adding rows does not read them.
    expect((await step("query", count, "step_4")).answer).toEqual(denied(DATA_STORE_ACTIONS.read));

    await grant(DATA_STORE_ACTIONS.read);
    const read = await step("query", count, "step_5");
    expect(read).toMatchObject({
      answer: "done",
      result: { output: { rows: [{ count: 1 }] } },
      run: { effect: "reading", actor: { kind: "service_principal", id: principal.id } }
    });

    // A load that changes or removes rows that are stored needs more than adding rows.
    for (const more of [
      { key: ["run_id"], onConflict: "update" },
      { key: ["run_id"], replace: { by: ["run_id"] } }
    ]) {
      expect(
        (
          await step(
            "load",
            { table: "findings", dataset, ...more },
            `step_load_${more.onConflict ?? "replace"}`
          )
        ).answer
      ).toEqual(denied(DATA_STORE_ACTIONS.execute));
    }
    // One that only adds is the principal's to make; no dataset of a run exists to read yet.
    expect(await step("load", { table: "findings", dataset }, "step_load")).toMatchObject({
      result: { status: "failed", error: { details: { reason: "not_supported_yet" } } }
    });
  });

  it("declares for each verb the scope, the caller, the effect and the right the contract names, and what a call waits for", async () => {
    const instance = await start(true);
    await publishStore(instance);

    const declared = await Promise.all(
      DATA_STORE_OPERATION_VERBS.map(async (verb) => {
        const operation = required(
          await instance.execution.operationCalls.registry.resolve(
            dataStoreOperationName("findings", verb)
          )
        );
        return [
          verb,
          operation.scope,
          operation.auth,
          operation.effect,
          // `load` asks its rights itself: which ones depends on what the call does.
          operation.action,
          operation.recordsEveryCall ?? false,
          operation.defaultPolicy
        ];
      })
    );

    // The routes ask the same scopes of a key as the operations they run.
    expect(
      (["query", "insert", "describe", "preview_rows"] as const).map(
        (verb) => apiOperations[`data_stores.${verb}`].scope
      )
    ).toEqual([
      DATA_STORE_OPERATION_SCOPES.query,
      DATA_STORE_OPERATION_SCOPES.insert,
      DATA_STORE_OPERATION_SCOPES.describe,
      DATA_STORE_OPERATION_SCOPES.preview_rows
    ]);
    const { read, insert } = DATA_STORE_ACTIONS;
    // A read is recorded every time and waits for nobody. Adding rows waits for nobody either:
    // a step of a Workflow Run has nobody there to confirm.
    expect(declared).toEqual([
      ["query", DATA_STORE_OPERATION_SCOPES.query, "principal", "reading", read, true, undefined],
      [
        "insert",
        DATA_STORE_OPERATION_SCOPES.insert,
        "principal",
        "changing",
        insert,
        false,
        "allow"
      ],
      ["load", DATA_STORE_OPERATION_SCOPES.load, "principal", "changing", null, false, "allow"],
      [
        "describe",
        DATA_STORE_OPERATION_SCOPES.describe,
        "principal",
        "reading",
        read,
        true,
        undefined
      ],
      [
        "preview_rows",
        DATA_STORE_OPERATION_SCOPES.preview_rows,
        "principal",
        "reading",
        read,
        true,
        undefined
      ]
    ]);
  });

  it("never runs a changing operation through a reading route", async () => {
    const instance = await start(true);
    await publishStore(instance);
    const count = async () =>
      (
        await overHttp(instance, "data_stores.query", {
          payload: { sql: "select count(*)::integer as count from findings" }
        })
      ).json();
    const viaReadingRoute = (store: string, payload: JsonObject) =>
      instance.api.call("data_stores.query", { params: { store }, payload });
    const insert = { table: "findings", rows: [finding] };

    // The route names its verb itself: an id that carries another verb is no store.
    const smuggled = await viaReadingRoute("findings.insert", { sql: "select 1" });
    expect(smuggled.statusCode).toBe(404);
    expect(smuggled.json<ErrorBody>().error.message).toBe("Data Store is not available");
    // And the body of an insert is no query: it is refused before anything runs.
    const asQuery = await viaReadingRoute("findings", insert);
    expect(asQuery.statusCode).toBeGreaterThanOrEqual(400);
    expect(asQuery.statusCode).toBeLessThan(500);
    expect(await count()).toMatchObject({ rows: [{ count: 0 }] });

    const runs = await instance.stores.operationRuns.list({ clientInstanceId });
    expect(
      runs.filter((run) => run.effect === "changing" && run.operation.startsWith("data_store"))
    ).toEqual([]);
  });

  it("answers an id no store has as not available, to a caller who holds the right", async () => {
    const instance = await start(true);

    const response = await instance.api.call("data_stores.describe", {
      params: { store: "nowhere" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.message).toBe("Data Store is not available");
  });

  it("offers the operations of a store to an agent as tools, each with a description of its use", async () => {
    const instance = await start(true);
    await publishStore(instance);
    const [source] = instance.execution.modulesStarted.dataToolSources;
    const names = DATA_STORE_OPERATION_VERBS.map((verb) =>
      dataStoreOperationName("findings", verb)
    );

    const tools = await required(source).describe([...names, "data_store.unknown.query"], {});

    // `load` is reserved: no agent is offered a tool that only refuses.
    expect(tools.map((tool) => [tool.name, tool.effect])).toEqual([
      ["data_store.findings.query", "reading"],
      ["data_store.findings.insert", "changing"],
      ["data_store.findings.describe", "reading"],
      ["data_store.findings.preview_rows", "reading"]
    ]);
    for (const tool of tools) {
      expect(tool.description).toContain("the Data Store 'Findings'");
      expect(tool.inputJsonSchema).toMatchObject({ type: "object" });
    }
  });

  it("answers the state of a store over HTTP to a caller who may read it", async () => {
    const instance = await start(true);
    const record = await publishStore(instance);
    const principal = await person(instance, "reader", ["user"]);
    const state = () => instance.api.call("data_stores.get", { params: { store: "findings" } });

    const answered = await state();
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({
      id: record.id,
      name: "findings",
      status: "ready",
      level: 1,
      publishedLevel: 1,
      size: { limitBytes: 5 * 1024 ** 3, nearLimit: false },
      lastMigration: { outcome: "applied", migration: { number: 1, name: "init" } }
    });
    // It is the store's own operation, asked the store's own right.
    const refused = await runOperation(
      {
        operation: "data_store.findings.state",
        effect: "reading",
        input: {},
        actor: principal,
        origin: { kind: "user" },
        correlationId: "corr_data_store"
      },
      instance.execution.operationCalls.deps
    );
    expect(refused.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: DATA_STORE_ACTIONS.read }
    });
    const none = await instance.api.call("data_stores.get", { params: { store: "nowhere" } });
    expect(none.statusCode).toBe(404);
  });

  it("gives back its connections to the stores when the process closes", async () => {
    const instance = await start(true);
    const admin = await person(instance, "user-1", ["user", "admin", "superadmin"]);
    const record = await publishStore(instance);
    await call(instance, admin, "query", { sql: "select 1 as one" });
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    const open = async () =>
      (
        await sql<{ count: number }[]>`
        select count(*)::integer as count from pg_stat_activity
        where usename = ${record.roles.app}`
      )[0]?.count;

    try {
      expect(await open()).toBeGreaterThan(0);
      await Promise.all(started.splice(0).map((process) => process.close()));
      await eventually(async () => expect(await open()).toBe(0));
    } finally {
      await sql.end();
    }
  });

  it("retires the store when its asset is deleted: the operations are gone and the rows stay", async () => {
    const instance = await start(true);
    const record = await publishStore(instance);
    await overHttp(instance, "data_stores.insert", {
      payload: { table: "findings", rows: [finding] }
    });

    const deleted = await instance.api.call("assets.delete", {
      params: { kind: DATA_STORE_ASSET_KIND, name: "findings" },
      payload: { expectedRevision: 1 }
    });

    expect(deleted.statusCode).toBe(200);
    expect(await recordOf(instance)).toMatchObject({ id: record.id, status: "retired" });
    expect(
      await instance.execution.operationCalls.registry.resolve(
        dataStoreOperationName("findings", "query")
      )
    ).toBeUndefined();
    expect(
      (await overHttp(instance, "data_stores.query", { payload: { sql: "select 1" } })).statusCode
    ).toBe(404);
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const inStore = postgres(url.toString(), { max: 1 });
    try {
      expect(await inStore`select client_id from findings`).toHaveLength(1);
    } finally {
      await inStore.end();
    }
    // The id is held while the retired database is there.
    expect((await put(instance)).statusCode).toBe(200);
    const again = await publish(instance, 1);
    expect(again.statusCode).toBe(409);
    expect(again.json<ErrorBody>().error.details).toMatchObject({ reason: "data_store_id_held" });
  });
});
