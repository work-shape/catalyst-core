import { describe, expect, expectTypeOf, it } from "vitest";
import { platformModules } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig, resolveModuleSwitches } from "@vivd-catalyst/config-schema";
import { connectionExposureDenial } from "@vivd-catalyst/connections";
import {
  ACTIONS,
  CONNECTION_EXPOSURES,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_JOB_KINDS,
  DATA_STORE_MANIFEST_FILE,
  DATA_STORE_OPERATION_PREFIX,
  DATA_STORE_OPERATION_RIGHTS,
  DATA_STORE_OPERATION_VERBS,
  DATA_STORE_PREVIEW_ROW_LIMIT,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_BASE_MANIFEST_FILE,
  KNOWLEDGE_OPERATION_PREFIX,
  KNOWLEDGE_QUERY_TOOL_NAME,
  MODULE_NAMES,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  WORKFLOW_MANIFEST_FILE,
  WORKFLOW_OPERATION_PREFIX,
  WORKFLOW_RUN_AS_ACTION,
  WORKFLOW_RUN_JOB_KINDS,
  WORKFLOW_RUN_MODES,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_STEP_FILES_FOLDER,
  WORKFLOW_STEP_RUN_STATUSES,
  WORKFLOW_STEP_TYPES,
  WORKFLOW_TRIGGER_KINDS,
  asClientInstanceId,
  asServicePrincipalId,
  auditActorFromServicePrincipal,
  callerCanConfirm,
  createAssetKindRegistry,
  createModuleRegistry,
  createPlatformId,
  dataStoreOperationName,
  defineAssetKind,
  defineJobKind,
  exposureOfOrigin,
  isAuthenticatedServicePrincipal,
  isDataToolName,
  knowledgeQueryOperationName,
  workflowStartOperationName,
  workflowStepIdempotencyKey,
  type ActingServicePrincipal,
  type AuthenticatedIdentity,
  type DataStoreCallOptions,
  type DataStoreHandle,
  type DataStoreJobKind,
  type DataStoreOperationVerb,
  type DataStoreParameter,
  type DataStoreReference,
  type DataStoreRows,
  type DataStoreStatement,
  type OperationOrigin,
  type WorkflowInputMapping,
  type WorkflowLoopCounts,
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
  type WorkflowTriggerKind,
  type WorkflowWire
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
            month: { ref: { step: "start", path: "month" } }
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
        }
      ]
    },
    {
      id: "summarise",
      name: "Summarise",
      type: "agent",
      instructions: "summarise.md",
      input: { results: { ref: { step: "each_client", path: "" } } },
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
  ],
  wiring: [
    { from: "start", to: "clients" },
    { from: "clients", to: "each_client" },
    { from: "each_client", to: "summarise" },
    { from: "summarise", to: "tell" },
    { from: "tell", to: "result" }
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
      "notify"
    ]);
    expect(WORKFLOW_TRIGGER_KINDS).toEqual(["manual", "schedule"]);
    expectTypeOf<WorkflowStep["type"]>().toEqualTypeOf<WorkflowStepType>();
    expectTypeOf<WorkflowTrigger["kind"]>().toEqualTypeOf<WorkflowTriggerKind>();
  });

  it("reads a definition with every step type as one manifest", () => {
    const steps: readonly WorkflowStep[] = manifest.steps;
    const wiring: readonly WorkflowWire[] = manifest.wiring;
    const types = new Set(steps.flatMap((step) => stepTypes(step)));

    expect([...types].sort()).toEqual([...WORKFLOW_STEP_TYPES].sort());
    expect(wiring.every((wire) => steps.some((step) => step.id === wire.to))).toBe(true);
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
      fireSchedule: "workflow_run.fire_schedule"
    });
    expectTypeOf<WorkflowRunJobKind>().toEqualTypeOf<
      "workflow_run.execute_step" | "workflow_run.fire_schedule"
    >();
    expect(WORKFLOW_OPERATION_PREFIX).toBe("workflow.");
    expect(workflowStartOperationName(manifest.id)).toBe("workflow.booking-check.start");
  });

  // Fails with the key of run and step: the three calls of one step in a loop shared one key,
  // so the second and third item answered with the result of the first and stored nothing.
  it("gives the call of one step its own key for each item of a loop", () => {
    const items = ["10432", "10433", "10434"];
    const stepRuns = items.map((label, index) => ({
      id: createPlatformId<"WorkflowStepRunId">("wfs"),
      stepId: "store",
      iteration: { index, label } satisfies WorkflowStepRunIteration
    }));

    const keys = stepRuns.map((stepRun) => workflowStepIdempotencyKey(stepRun.id));
    expect(new Set(keys).size).toBe(items.length);
    // A retried attempt of one step run has the key of its first attempt.
    expect(stepRuns.map((stepRun) => workflowStepIdempotencyKey(stepRun.id))).toEqual(keys);
    expect(keys).toEqual(stepRuns.map((stepRun) => `workflow_step:${stepRun.id}`));

    const counts: WorkflowLoopCounts = { total: 3, done: 2, failed: 1, running: 0 };
    expect(counts.done + counts.failed + counts.running).toBe(counts.total);
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
    expect(DATA_STORE_OPERATION_VERBS).toEqual(["query", "insert", "describe", "preview_rows"]);
    expectTypeOf<DataStoreOperationVerb>().toEqualTypeOf<
      "query" | "insert" | "describe" | "preview_rows"
    >();
    // A Data Store has no `use`: a run's principal inserts with `data_store.write` on the store.
    expect(DATA_STORE_OPERATION_RIGHTS).toEqual({
      query: "data_store.read",
      insert: "data_store.write",
      describe: "data_store.read",
      preview_rows: "data_store.read"
    });
    expect(DATA_STORE_ACTIONS).not.toHaveProperty("use");
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
    // None of the new prefixes is a data tool prefix yet: a release tool may still take one.
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

  it("hands a caller the rows of one store through a handle", async () => {
    const reference: DataStoreReference = { name: "findings", minSchema: 2 };
    const written: DataStoreStatement[] = [];
    const handle: DataStoreHandle = {
      store: reference.name,
      schemaLevel: 2,
      query: (statement) =>
        Promise.resolve({
          columns: [{ name: "rule", type: "text" }],
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

  it("contribute nothing yet, so nothing is switched by either", () => {
    for (const module of [workflowsModule, dataStoresModule, knowledgeModule]) {
      expect(module).toEqual({
        name: module.name,
        requires: [],
        kinds: [],
        operations: [],
        selfCheckedOperations: [],
        jobKinds: [],
        commandWorkerJobKinds: [],
        tools: [],
        ui: []
      });
    }
    const off = createModuleRegistry(platformModules).snapshot({});
    for (const [contribution, name] of [
      ["kind", WORKFLOW_ASSET_KIND],
      ["kind", DATA_STORE_ASSET_KIND],
      ["kind", KNOWLEDGE_BASE_ASSET_KIND],
      ["jobKind", WORKFLOW_RUN_JOB_KINDS.executeStep],
      ["jobKind", DATA_STORE_JOB_KINDS.provision],
      ["tool", KNOWLEDGE_QUERY_TOOL_NAME]
    ] as const) {
      expect(off.offModuleOf(contribution, name), name).toBeUndefined();
    }
  });
});

function stepTypes(step: WorkflowStep): WorkflowStepType[] {
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
