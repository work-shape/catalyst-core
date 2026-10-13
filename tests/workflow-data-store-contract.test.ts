import { describe, expect, expectTypeOf, it } from "vitest";
import { platformModules } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig, resolveModuleSwitches } from "@vivd-catalyst/config-schema";
import { connectionExposureDenial } from "@vivd-catalyst/connections";
import {
  ACTIONS,
  CONNECTION_EXPOSURES,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_INSERT_CONFLICT_MODES,
  DATA_STORE_JOB_KINDS,
  DATA_STORE_MANIFEST_FILE,
  DATA_STORE_OPERATION_PREFIX,
  DATA_STORE_OPERATION_RIGHTS,
  DATA_STORE_OPERATION_VERBS,
  DATA_STORE_PREVIEW_ROW_LIMIT,
  DATA_STORE_SCALAR_TYPES,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_BASE_MANIFEST_FILE,
  KNOWLEDGE_OPERATION_PREFIX,
  KNOWLEDGE_QUERY_TOOL_NAME,
  MODULE_NAMES,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  WORKFLOW_DOWNLOAD_DATASET_OPERATION,
  WORKFLOW_LOOP_ITEM_FAILURE_MODES,
  WORKFLOW_LOOP_MAX_CONCURRENCY,
  WORKFLOW_MANIFEST_FILE,
  WORKFLOW_OPERATION_PREFIX,
  WORKFLOW_RUN_AS_ACTION,
  WORKFLOW_RUN_JOB_KINDS,
  WORKFLOW_RUN_MODES,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_STEP_FILES_FOLDER,
  WORKFLOW_STEP_RUN_STATUSES,
  WORKFLOW_STEP_TYPES,
  WORKFLOW_RESERVED_STEP_TYPES,
  WORKFLOW_TRIGGER_KINDS,
  asClientInstanceId,
  asServicePrincipalId,
  auditActorFromServicePrincipal,
  callerCanConfirm,
  createAssetKindRegistry,
  createModuleRegistry,
  createPlatformId,
  dataStoreInsertConflictSchema,
  dataStoreInsertResultSchema,
  dataStoreOperationName,
  defineAssetKind,
  defineJobKind,
  exposureOfOrigin,
  isAuthenticatedServicePrincipal,
  isDataToolName,
  knowledgeQueryOperationName,
  workflowLoopOptionsSchema,
  workflowStartOperationName,
  workflowStepIdempotencyKey,
  type ActingServicePrincipal,
  type AuthenticatedIdentity,
  type DataStoreCallOptions,
  type DataStoreColumn,
  type DataStoreColumnType,
  type DataStoreHandle,
  type DataStoreInsertInput,
  type DataStoreInsertResult,
  type DataStoreJobKind,
  type DataStoreOperationVerb,
  type DataStoreParameter,
  type DataStoreParameterType,
  type DataStoreReference,
  type DataStoreRows,
  type DataStoreScalarType,
  type DataStoreStatement,
  type OperationOrigin,
  type WorkflowInputMapping,
  type WorkflowLoopCounts,
  type WorkflowDatasetReference,
  type WorkflowLoopFailure,
  type WorkflowLoopItemFailureMode,
  type WorkflowLoopOutput,
  type WorkflowInputValue,
  type WorkflowManifest,
  type WorkflowReference,
  type WorkflowRunId,
  type WorkflowRunJobKind,
  type WorkflowRunMode,
  type WorkflowRunPrincipal,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowStepRunId,
  type WorkflowStepRunIteration,
  type WorkflowStepRunStatus,
  type WorkflowStepType,
  type WorkflowTrigger,
  type WorkflowTriggerKind
} from "@vivd-catalyst/core";
import { dataStoresModule, knowledgeModule } from "@vivd-catalyst/data-stores";
import { workflowsModule } from "@vivd-catalyst/workflows";
import { createTestConfig } from "./support/fixtures";

// The names two lines of work build on side by side: Workflows and Data Stores. Each test
// fails without `core/src/workflows.ts`, `core/src/data-stores.ts` and the two modules: none
// of the names existed before them.

const runId = createPlatformId<"WorkflowRunId">("wfr");
const stepRunId = createPlatformId<"WorkflowStepRunId">("wfs");
const workflowOrigin: OperationOrigin = { kind: "workflow", workflowRunId: runId, stepRunId };
const scheduleOrigin: OperationOrigin = { kind: "schedule", scheduleId: "sch_1" };

/** A monthly check of bookings, as a definition holds it once `workflow.yaml` is read. */
const manifest: WorkflowManifest = {
  id: "booking-check",
  name: "Booking check",
  runAs: "booking-check",
  inputs: { type: "object", properties: { month: { type: "string" } } },
  outputs: { type: "object", properties: { findings: { type: "number" } } },
  steps: [
    {
      id: "start",
      name: "Start",
      type: "trigger",
      triggers: [{ kind: "manual" }, { kind: "schedule", cron: "0 6 1 * *" }]
    },
    {
      id: "clients",
      name: "Read the Mandanten",
      type: "operation",
      operation: "connection.exampledata.list_clients",
      input: {}
    },
    {
      id: "each_client",
      name: "For each Mandant",
      description: "Checks the bookings of every Mandant of the month.",
      type: "loop",
      items: { step: "clients", path: "clients" },
      itemName: "Mandant",
      itemLabel: "label",
      steps: [
        {
          id: "bookings",
          name: "Read the bookings",
          type: "operation",
          operation: "connection.exampledata.list_bookings",
          input: {
            client: { ref: { step: "each_client", path: "id" } },
            // The output of the trigger step is `{ input, startedAt, trigger }`.
            month: { ref: { step: "start", path: "input.month" } }
          }
        },
        {
          id: "check",
          name: "Check the bookings",
          type: "code",
          file: "check.py",
          input: { bookings: { ref: { step: "bookings", path: "" } } },
          inputSchema: { type: "object" },
          outputSchema: { type: "object" }
        },
        {
          id: "store",
          name: "Store the findings",
          type: "operation",
          operation: dataStoreOperationName("findings", "insert"),
          input: { rows: { ref: { step: "check", path: "findings" } } }
        },
        {
          id: "archive",
          name: "Archive the Mandant",
          type: "workflow",
          workflow: "client-archive",
          input: { client: { ref: { step: "each_client", path: "id" } } }
        }
      ]
    },
    {
      id: "summarise",
      name: "Summarise",
      type: "agent",
      instructions: "summarise.md",
      // What a loop hands on is how many items ended how. The findings are in the store.
      input: { failed: { ref: { step: "each_client", path: "failed" } } },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    },
    {
      id: "tell",
      name: "Send the summary",
      type: "notify",
      channel: "mail",
      input: { text: { ref: { step: "summarise", path: "summary" } } }
    },
    { id: "result", name: "Result", type: "output", input: { findings: { value: 0 } } }
  ]
};

describe("the names of a Workflow", () => {
  it("fixes the asset kind, its files and the step and trigger lists", () => {
    expect(WORKFLOW_ASSET_KIND).toBe("workflow");
    expect(WORKFLOW_MANIFEST_FILE).toBe("workflow.yaml");
    expect(WORKFLOW_STEP_FILES_FOLDER).toBe("steps");
    expect(WORKFLOW_STEP_TYPES).toEqual([
      "trigger",
      "operation",
      "loop",
      "code",
      "output",
      "agent",
      "notify",
      "workflow"
    ]);
    expect(WORKFLOW_TRIGGER_KINDS).toEqual(["manual", "schedule", "parent"]);
    // The reserved block types have a shape and are in no list of what a definition may name.
    expectTypeOf<
      Exclude<WorkflowStep["type"], (typeof WORKFLOW_RESERVED_STEP_TYPES)[number]>
    >().toEqualTypeOf<WorkflowStepType>();
    expectTypeOf<WorkflowTrigger["kind"]>().toEqualTypeOf<WorkflowTriggerKind>();
  });

  it("reads a definition with every step type as one manifest", () => {
    const steps: readonly WorkflowStep[] = manifest.steps;
    const types = new Set(steps.flatMap((step) => stepTypes(step)));

    expect([...types].sort()).toEqual([...WORKFLOW_STEP_TYPES].sort());
    // The order of the steps is the order of the list: the file has no wiring.
    expectTypeOf<WorkflowManifest>().not.toHaveProperty("wiring");
    expectTypeOf<WorkflowInputMapping[string]>().toEqualTypeOf<WorkflowInputValue>();
    expectTypeOf<
      Extract<WorkflowInputValue, { ref: unknown }>["ref"]
    >().toEqualTypeOf<WorkflowReference>();
  });

  it("fixes the states of a run and of a step run", () => {
    expect(WORKFLOW_RUN_MODES).toEqual(["live", "test"]);
    expect(WORKFLOW_RUN_STATUSES).toEqual([
      "queued",
      "running",
      "waiting",
      "done",
      "failed",
      "cancelled",
      "limit_reached"
    ]);
    expect(WORKFLOW_STEP_RUN_STATUSES).toEqual(
      WORKFLOW_RUN_STATUSES.filter((status) => status !== "limit_reached")
    );
    expectTypeOf<WorkflowRunMode>().toEqualTypeOf<"live" | "test">();
    expectTypeOf<WorkflowStepRunStatus>().toEqualTypeOf<
      Exclude<WorkflowRunStatus, "limit_reached">
    >();
    expectTypeOf<WorkflowRunId>().not.toEqualTypeOf<WorkflowStepRunId>();
  });

  it("names its jobs as kinds the executor accepts and its operations without a second dot", () => {
    for (const kind of Object.values(WORKFLOW_RUN_JOB_KINDS)) {
      expect(jobKindOf(kind).kind).toBe(kind);
    }
    expect(WORKFLOW_RUN_JOB_KINDS).toEqual({
      executeStep: "workflow_run.execute_step",
      fireSchedule: "workflow_run.fire_schedule",
      pruneData: "workflow_run.prune_data",
      deleteDatasets: "workflow_run.delete_datasets"
    });
    expectTypeOf<WorkflowRunJobKind>().toEqualTypeOf<
      | "workflow_run.execute_step"
      | "workflow_run.fire_schedule"
      | "workflow_run.prune_data"
      | "workflow_run.delete_datasets"
    >();
    expect(WORKFLOW_DOWNLOAD_DATASET_OPERATION).toBe("workflows.download_dataset");
    expect(WORKFLOW_ACTIONS.readRunData).toBe("workflow.read_run_data");
    expect(WORKFLOW_OPERATION_PREFIX).toBe("workflow.");
    expect(workflowStartOperationName(manifest.id)).toBe("workflow.booking-check.start");
  });

  // The key is made of the step run alone, so one step has one per item of its loop. What an
  // Operation Run does with three such keys is in `workflow-step-idempotency.test.ts`.
  it("gives the call of one step its own key for each item of a loop", () => {
    const items = ["10432", "10433", "10434"];
    const stepRuns = items.map((label, index) => ({
      id: createPlatformId<"WorkflowStepRunId">("wfs"),
      stepId: "store",
      iteration: { index, label } satisfies WorkflowStepRunIteration
    }));

    const keys = stepRuns.map((stepRun) => workflowStepIdempotencyKey(stepRun.id));
    // A retried attempt of one step run has the key of its first attempt.
    expect(stepRuns.map((stepRun) => workflowStepIdempotencyKey(stepRun.id))).toEqual(keys);
    expect(keys).toEqual(stepRuns.map((stepRun) => `workflow_step:${stepRun.id}`));

    const counts: WorkflowLoopCounts = { total: 3, done: 2, failed: 1, running: 0 };
    expect(counts.done + counts.failed + counts.running).toBe(counts.total);
  });

  // Fails without the loop options: a definition could not say that one failed item of 600
  // leaves the other 599 standing.
  it("reads what a failed item does to a loop and how many items run at once", () => {
    expect(WORKFLOW_LOOP_ITEM_FAILURE_MODES).toEqual(["stop", "continue"]);
    expect(WORKFLOW_LOOP_MAX_CONCURRENCY).toBe(8);
    expect(workflowLoopOptionsSchema.parse({})).toEqual({ onItemFailure: "stop", concurrency: 1 });
    expect(
      workflowLoopOptionsSchema.parse({
        onItemFailure: "continue",
        concurrency: WORKFLOW_LOOP_MAX_CONCURRENCY,
        collect: { step: "check", path: "findings" }
      })
    ).toEqual({
      onItemFailure: "continue",
      concurrency: 8,
      collect: { step: "check", path: "findings" }
    });
    for (const refused of [
      { onItemFailure: "fail" },
      { concurrency: 0 },
      { concurrency: 1.5 },
      { concurrency: WORKFLOW_LOOP_MAX_CONCURRENCY + 1 },
      { collect: "check.findings" }
    ]) {
      expect(workflowLoopOptionsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false
      );
    }

    const loop = manifest.steps.find((step) => step.type === "loop");
    expectTypeOf<NonNullable<typeof loop>["onItemFailure"]>().toEqualTypeOf<
      WorkflowLoopItemFailureMode | undefined
    >();
    expectTypeOf<NonNullable<typeof loop>["collect"]>().toEqualTypeOf<
      WorkflowReference | undefined
    >();
    // A loop that continued is `done`. A later step reads its counts and, as datasets, the
    // items that failed and what `collect` named. It reads no item's result inline.
    const failure: WorkflowLoopFailure = { index: 1, label: "10433", error: "upstream_failed" };
    const failures: WorkflowDatasetReference = { $dataset: "ds_1", rowCount: 1, bytes: 64 };
    const output: WorkflowLoopOutput = { total: 3, done: 2, failed: 1, failures };
    expect(output.done + output.failed).toBe(output.total);
    expect(failure.index).toBe(1);
    expectTypeOf<keyof WorkflowLoopOutput>().toEqualTypeOf<
      "total" | "done" | "failed" | "results" | "failures"
    >();
  });

  it("carries the run's principal as the actor of a call and the run as its origin", () => {
    const principal: WorkflowRunPrincipal = {
      kind: "service",
      id: asServicePrincipalId("sp_1"),
      displayLabel: manifest.runAs,
      permissionRefs: [],
      permissions: [],
      clientInstanceId: asClientInstanceId("demo-local"),
      authSource: "workflow_run",
      scopes: [],
      workflowRunId: runId
    };
    // The operation layer takes it where it takes a principal with a credential.
    const identity: AuthenticatedIdentity = principal;

    expect(isAuthenticatedServicePrincipal(identity)).toBe(true);
    expect(auditActorFromServicePrincipal(principal)).not.toHaveProperty("credentialId");
    expectTypeOf<WorkflowRunPrincipal>().toExtend<ActingServicePrincipal>();
    expectTypeOf<WorkflowRunPrincipal>().not.toHaveProperty("credentialId");
    // Publishing or testing a Workflow that names a principal needs the right over principals.
    expect(WORKFLOW_RUN_AS_ACTION).toBe("api_access.manage");
    expect(workflowOrigin).toEqual({ kind: "workflow", workflowRunId: runId, stepRunId });
    // Nobody is present in a run or at a due time: neither call confirms itself.
    expect(callerCanConfirm(workflowOrigin)).toBe(false);
    expect(callerCanConfirm(scheduleOrigin)).toBe(false);
  });
});

describe("a Connection called from a schedule", () => {
  // Pins what holds today: a step of a run reaches a Connection through the exposure
  // `workflow`, and a due time by itself reaches none, whatever the operation is exposed to.
  it("is refused for every exposure, and a step of a Workflow Run needs `workflow`", () => {
    expect(exposureOfOrigin(scheduleOrigin)).toBeUndefined();
    expect(exposureOfOrigin(workflowOrigin)).toBe("workflow");

    for (const exposure of [
      [],
      ...CONNECTION_EXPOSURES.map((one) => [one]),
      CONNECTION_EXPOSURES
    ]) {
      expect(connectionExposureDenial({ exposure: [...exposure] }, scheduleOrigin)).toEqual({
        allowed: false,
        action: "connection_exposure:schedule",
        reason: "no_grant"
      });
    }
    expect(connectionExposureDenial({ exposure: ["workflow"] }, workflowOrigin)).toBeUndefined();
    expect(connectionExposureDenial({ exposure: ["agent", "bridge"] }, workflowOrigin)).toEqual({
      allowed: false,
      action: "connection_exposure:workflow",
      reason: "no_grant"
    });
  });
});

describe("the names of a Data Store and of a Knowledge Base", () => {
  it("fixes three asset kinds that register side by side", () => {
    expect(DATA_STORE_ASSET_KIND).toBe("data_store");
    expect(DATA_STORE_MANIFEST_FILE).toBe("store.yaml");
    expect(KNOWLEDGE_BASE_ASSET_KIND).toBe("knowledge_base");
    expect(KNOWLEDGE_BASE_MANIFEST_FILE).toBe("kb.yaml");

    const kinds = [
      [WORKFLOW_ASSET_KIND, "workflows"],
      [DATA_STORE_ASSET_KIND, "data_stores"],
      [KNOWLEDGE_BASE_ASSET_KIND, "knowledge_bases"]
    ] as const;
    const registry = createAssetKindRegistry(kinds.map(([kind, plural]) => kindOf(kind, plural)));
    expect(registry.kinds.map((kind) => kind.kind)).toEqual([
      "workflow",
      "data_store",
      "knowledge_base"
    ]);
  });

  it("names the operations on rows, the knowledge query and the jobs of the store", () => {
    expect(DATA_STORE_OPERATION_PREFIX).toBe("data_store.");
    expect(DATA_STORE_OPERATION_VERBS).toEqual([
      "query",
      "insert",
      "load",
      "describe",
      "preview_rows"
    ]);
    expectTypeOf<DataStoreOperationVerb>().toEqualTypeOf<
      "query" | "insert" | "load" | "describe" | "preview_rows"
    >();
    // Adding rows is a right of its own: a run's principal holds `data_store.insert` on the
    // store and cannot edit its migrations, which is `data_store.write`.
    expect(DATA_STORE_OPERATION_RIGHTS).toEqual({
      query: "data_store.read",
      insert: "data_store.insert",
      load: "data_store.insert",
      describe: "data_store.read",
      preview_rows: "data_store.read"
    });
    expect(DATA_STORE_ACTIONS).not.toHaveProperty("use");
    expect(DATA_STORE_ACTIONS.insert).not.toBe(DATA_STORE_ACTIONS.write);
    // Reserved for changing statements other than an insert: no operation asks it yet.
    expect(DATA_STORE_ACTIONS.execute).toBe("data_store.execute");
    expect(Object.values(DATA_STORE_OPERATION_RIGHTS)).not.toContain(DATA_STORE_ACTIONS.execute);
    expect(DATA_STORE_PREVIEW_ROW_LIMIT).toBe(50);
    for (const action of [
      ...Object.values(WORKFLOW_ACTIONS),
      ...Object.values(DATA_STORE_ACTIONS),
      ...Object.values(KNOWLEDGE_BASE_ACTIONS)
    ]) {
      expect(ACTIONS, action).toContain(action);
    }
    expect(dataStoreOperationName("findings", "query")).toBe("data_store.findings.query");
    expect(dataStoreOperationName("findings", "insert")).toBe("data_store.findings.insert");
    expect(KNOWLEDGE_OPERATION_PREFIX).toBe("knowledge.");
    expect(KNOWLEDGE_QUERY_TOOL_NAME).toBe("knowledge.query");
    expect(knowledgeQueryOperationName("findings")).toBe("knowledge.findings.query");
    // None of the new prefixes is a data tool prefix: an agent carries none of these names as
    // a data tool. The registry keeps a release tool off them (`SOURCED_OPERATION_PREFIXES`).
    for (const name of [
      workflowStartOperationName("w"),
      dataStoreOperationName("s", "query"),
      KNOWLEDGE_QUERY_TOOL_NAME
    ]) {
      expect(isDataToolName(name), name).toBe(false);
    }

    for (const kind of Object.values(DATA_STORE_JOB_KINDS)) {
      expect(jobKindOf(kind).kind).toBe(kind);
    }
    expect(DATA_STORE_JOB_KINDS).toEqual({
      provision: "data_store.provision",
      migrate: "data_store.migrate",
      measureSize: "data_store.measure_size"
    });
    expectTypeOf<DataStoreJobKind>().toEqualTypeOf<
      "data_store.provision" | "data_store.migrate" | "data_store.measure_size"
    >();
  });

  // Fails without the conflict mode: an insert had no way to say what a duplicate does, so a
  // rerun of a Workflow stored every finding twice or failed on the first one.
  it("says what an insert does with a duplicate, and counts what it left out", () => {
    expect(DATA_STORE_INSERT_CONFLICT_MODES).toEqual(["fail", "skip"]);
    expect(dataStoreInsertConflictSchema.parse(undefined)).toBe("fail");
    expect(dataStoreInsertConflictSchema.parse("skip")).toBe("skip");
    expect(dataStoreInsertConflictSchema.safeParse("update").success).toBe(false);

    const input: DataStoreInsertInput = {
      table: "findings",
      rows: [{ client: "10432", rule: "duplicate" }],
      onConflict: "skip"
    };
    const result: DataStoreInsertResult = dataStoreInsertResultSchema.parse({
      table: input.table,
      inserted: 0,
      skipped: 1
    });
    expect(result.inserted + result.skipped).toBe(input.rows.length);
    expect(dataStoreInsertResultSchema.safeParse({ table: "findings", inserted: 1 }).success).toBe(
      false
    );
    expect(
      dataStoreInsertResultSchema.safeParse({ table: "t", inserted: -1, skipped: 0 }).success
    ).toBe(false);
  });

  // Fails with the raw type alone: a caller of `describe` read `numeric(12,2)` or `int8` and
  // had to know the backend to bind a value to the column.
  it("names a column by a type of the product and keeps the database's own beside it", () => {
    expect(DATA_STORE_SCALAR_TYPES).toEqual([
      "text",
      "integer",
      "number",
      "boolean",
      "date",
      "timestamp"
    ]);
    const columns: DataStoreColumn[] = [
      {
        name: "amount",
        type: "number",
        nativeType: "numeric(12,2)",
        nullable: false,
        primaryKey: false
      },
      { name: "tags", type: "text[]", nativeType: "text[]", nullable: true, primaryKey: false },
      { name: "payload", type: "other", nativeType: "jsonb", nullable: true, primaryKey: false }
    ];
    expect(columns.map((column) => column.type)).toEqual(["number", "text[]", "other"]);
    expectTypeOf<DataStoreColumnType>().toEqualTypeOf<DataStoreParameterType | "other">();
    expectTypeOf<DataStoreParameterType>().toEqualTypeOf<
      DataStoreScalarType | `${DataStoreScalarType}[]`
    >();
    expectTypeOf<{ type: "date"; value: string }>().toExtend<DataStoreParameter>();
  });

  it("hands a caller the rows of one store through a handle", async () => {
    const reference: DataStoreReference = { name: "findings", minSchema: 2 };
    const written: DataStoreStatement[] = [];
    const handle: DataStoreHandle = {
      store: reference.name,
      schemaLevel: 2,
      query: (statement) =>
        Promise.resolve({
          columns: [{ name: "rule", type: "text", nativeType: "character varying(40)" }],
          rows: [{ rule: String(statement.parameters?.[0]) }],
          truncated: false
        }),
      execute: (statement) => {
        written.push(statement);
        return Promise.resolve({ rowCount: 1 });
      }
    };

    const rows = await handle.query({ sql: "select $1 as rule", parameters: ["duplicate"] });
    const changed = await handle.execute({ sql: "insert into findings (rule) values ($1)" });

    expect(rows.rows).toEqual([{ rule: "duplicate" }]);
    expect(changed).toEqual({ rowCount: 1 });
    expect(written).toHaveLength(1);
    expectTypeOf<Awaited<ReturnType<DataStoreHandle["query"]>>>().toEqualTypeOf<DataStoreRows>();
    expectTypeOf<Parameters<DataStoreHandle["query"]>[1]>().toEqualTypeOf<
      DataStoreCallOptions | undefined
    >();
    expectTypeOf<readonly string[]>().toExtend<DataStoreParameter>();
  });
});

describe("the modules workflows and dataStores", () => {
  it("are known, registered by their packages, and off unless a config turns them on", () => {
    expect(MODULE_NAMES).toContain("workflows");
    expect(MODULE_NAMES).toContain("dataStores");
    expect(MODULE_NAMES).toContain("knowledge");
    expect(platformModules).toContain(knowledgeModule);
    expect(workflowsModule.name).toBe("workflows");
    expect(dataStoresModule.name).toBe("dataStores");
    expect(platformModules).toContain(workflowsModule);
    expect(platformModules).toContain(dataStoresModule);

    const registry = createModuleRegistry(platformModules);
    const byDefault = registry.snapshot(
      resolveModuleSwitches(parseClientInstanceConfig(createTestConfig()))
    );
    expect(byDefault.isEnabled("workflows")).toBe(false);
    expect(byDefault.isEnabled("dataStores")).toBe(false);

    const on = registry.snapshot({
      workflows: { enabled: true },
      dataStores: { enabled: true }
    });
    expect(on.isEnabled("workflows")).toBe(true);
    expect(on.isEnabled("dataStores")).toBe(true);
  });

  it("contribute what is built: nothing for Knowledge yet, the runs and the job of Workflows, the kind and the jobs of Data Stores", () => {
    const nothing = {
      requires: [],
      kinds: [],
      operations: [],
      selfCheckedOperations: [],
      jobKinds: [],
      commandWorkerJobKinds: [],
      tools: [],
      ui: []
    };
    expect(knowledgeModule).toEqual({ ...nothing, name: "knowledge" });
    // The kind of a Workflow, its runs and the job that executes their steps.
    expect(workflowsModule).toEqual({
      ...nothing,
      name: "workflows",
      kinds: [WORKFLOW_ASSET_KIND],
      operations: [
        "workflows.list",
        "workflows.start",
        "workflows.get_run",
        "workflows.list_runs",
        "workflows.list_step_runs",
        "workflows.cancel_run"
      ],
      jobKinds: [
        WORKFLOW_RUN_JOB_KINDS.executeStep,
        WORKFLOW_RUN_JOB_KINDS.fireSchedule,
        "workflow_run.run_code",
        "workflow_run.sweep_code",
        WORKFLOW_RUN_JOB_KINDS.pruneData
      ],
      // The script of a code step runs in the sandbox, which the command worker reaches.
      commandWorkerJobKinds: ["workflow_run.run_code", "workflow_run.sweep_code"]
    });
    expect(dataStoresModule).toEqual({
      ...nothing,
      name: "dataStores",
      kinds: [DATA_STORE_ASSET_KIND],
      operations: [
        "data_stores.query",
        "data_stores.insert",
        "data_stores.describe",
        "data_stores.preview_rows",
        "data_stores.get"
      ],
      jobKinds: Object.values(DATA_STORE_JOB_KINDS)
    });
    const off = createModuleRegistry(platformModules).snapshot({});
    for (const [contribution, name] of [
      ["kind", KNOWLEDGE_BASE_ASSET_KIND],
      ["tool", KNOWLEDGE_QUERY_TOOL_NAME]
    ] as const) {
      expect(off.offModuleOf(contribution, name), name).toBeUndefined();
    }
    expect(off.offModuleOf("kind", WORKFLOW_ASSET_KIND)).toBe("workflows");
    expect(off.offModuleOf("jobKind", WORKFLOW_RUN_JOB_KINDS.executeStep)).toBe("workflows");
    expect(off.offModuleOf("operation", "workflows.start")).toBe("workflows");
    expect(off.offModuleOf("kind", DATA_STORE_ASSET_KIND)).toBe("dataStores");
    expect(off.offModuleOf("jobKind", DATA_STORE_JOB_KINDS.provision)).toBe("dataStores");
  });
});

function stepTypes(step: WorkflowStep): WorkflowStep["type"][] {
  return step.type === "loop" ? [step.type, ...step.steps.flatMap(stepTypes)] : [step.type];
}

function jobKindOf(kind: string) {
  return defineJobKind({
    kind,
    payloadSchema: { parse: () => ({}) },
    maxAttempts: 3,
    backoff: { baseMs: 1000, maxMs: 60_000 },
    leaseMs: 60_000,
    concurrency: {}
  });
}

function kindOf(kind: string, plural: string) {
  return defineAssetKind({
    kind,
    plural,
    schema: {
      safeParse: (input: unknown) => ({ success: true as const, data: { name: String(input) } })
    },
    nameRule: { pattern: /^[a-z][a-z0-9-]*$/u, description: "lowercase" },
    actions: { read: `${kind}.read`, write: `${kind}.write`, delete: `${kind}.delete` },
    validate: () => [],
    summarize: (definition) => ({ name: definition.name, title: definition.name })
  });
}
