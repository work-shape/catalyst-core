import { describe, expect, it } from "vitest";
import { guardrailsModule, platformModules } from "@work-shape/catalyst-client-assembly";
import {
  parseClientInstanceConfig,
  resolveModuleSwitches
} from "@work-shape/catalyst-config-schema";
import { connectionExposureDenial } from "@work-shape/catalyst-connections";
import {
  ACTIONS,
  CONNECTION_EXPOSURES,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_JOB_KINDS,
  DATA_STORE_OPERATION_RIGHTS,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_QUERY_TOOL_NAME,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  WORKFLOW_LOOP_MAX_CONCURRENCY,
  WORKFLOW_RUN_JOB_KINDS,
  WORKFLOW_STEP_TYPES,
  asClientInstanceId,
  asServicePrincipalId,
  auditActorFromServicePrincipal,
  callerCanConfirm,
  createModuleRegistry,
  createPlatformId,
  dataStoreInsertConflictSchema,
  dataStoreOperationName,
  exposureOfOrigin,
  isAuthenticatedServicePrincipal,
  isDataToolName,
  workflowLoopOptionsSchema,
  workflowStartOperationName,
  workflowStepIdempotencyKey,
  type OperationOrigin,
  type WorkflowManifest,
  type WorkflowRunPrincipal,
  type WorkflowStep
} from "@work-shape/catalyst-core";
import { dataStoresModule, knowledgeModule } from "@work-shape/catalyst-data-stores";
import { parseWorkflowManifest, workflowsModule } from "@work-shape/catalyst-workflows";
import { createTestConfig } from "./support/fixtures";

// What Workflows and Data Stores build on side by side: a definition of every step type, the
// rights of the operations on rows, the origin of a run's calls, and the modules.

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
      to: { users: ["usr_reviewer"] },
      channels: ["inbox", "mail"],
      title: { value: "Summary" },
      text: { ref: { step: "summarise", path: "summary" } }
    },
    {
      id: "check_failures",
      name: "Check failures",
      type: "condition",
      when: { ref: { step: "each_client", path: "failed" }, op: "greater_than", value: 0 },
      then: [{ id: "independent", name: "Independent checks", type: "parallel", branches: [] }]
    },
    { id: "result", name: "Result", type: "output", input: { findings: { value: 0 } } }
  ]
};

describe("a Workflow", () => {
  it("reads a definition with every step type as one manifest", () => {
    expect(parseWorkflowManifest(manifest)).toMatchObject({ ok: true });
    const types = new Set(manifest.steps.flatMap((step) => stepTypes(step)));
    expect([...types].sort()).toEqual([...WORKFLOW_STEP_TYPES].sort());
  });

  it("gives the call of one step run one key, whatever attempt makes it", () => {
    const id = createPlatformId<"WorkflowStepRunId">("wfs");
    expect(workflowStepIdempotencyKey(id)).toBe(workflowStepIdempotencyKey(id));
    expect(workflowStepIdempotencyKey(id)).not.toBe(
      workflowStepIdempotencyKey(createPlatformId<"WorkflowStepRunId">("wfs"))
    );
  });

  it("reads what a failed item does to a loop and how many items run at once", () => {
    expect(workflowLoopOptionsSchema.parse({})).toEqual({ onItemFailure: "stop", concurrency: 1 });
    for (const refused of [
      { onItemFailure: "fail" },
      { concurrency: 0 },
      { concurrency: WORKFLOW_LOOP_MAX_CONCURRENCY + 1 },
      { collect: "check.findings" }
    ]) {
      expect(workflowLoopOptionsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false
      );
    }
  });

  it("carries the run's principal as the actor of a call, and no call of a run confirms itself", () => {
    const principal: WorkflowRunPrincipal = {
      kind: "service",
      id: asServicePrincipalId("sp_1"),
      displayLabel: manifest.runAs ?? manifest.name,
      permissionRefs: [],
      permissions: [],
      clientInstanceId: asClientInstanceId("demo-local"),
      authSource: "workflow_run",
      scopes: [],
      workflowRunId: runId
    };
    expect(isAuthenticatedServicePrincipal(principal)).toBe(true);
    expect(auditActorFromServicePrincipal(principal)).not.toHaveProperty("credentialId");
    // Nobody is present in a run or at a due time: neither call confirms itself.
    expect(callerCanConfirm(workflowOrigin)).toBe(false);
    expect(callerCanConfirm(scheduleOrigin)).toBe(false);
  });
});

describe("a Connection called from a schedule", () => {
  // A step of a run reaches a Connection through the exposure `workflow`, and a due time by
  // itself reaches none, whatever the operation is exposed to.
  it("is refused for every exposure, and a step of a Workflow Run needs `workflow`", () => {
    expect(exposureOfOrigin(scheduleOrigin)).toBeUndefined();
    expect(exposureOfOrigin(workflowOrigin)).toBe("workflow");
    for (const exposure of [[], CONNECTION_EXPOSURES]) {
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

describe("the rights of a Data Store", () => {
  it("asks a right of its own for adding rows and the execute right for changing them", () => {
    // A run's principal holds `data_store.insert` on the store and cannot edit its
    // migrations, which is `data_store.write`.
    expect(DATA_STORE_OPERATION_RIGHTS.insert).toBe("data_store.insert");
    expect(DATA_STORE_OPERATION_RIGHTS.load).toBe("data_store.insert");
    expect(DATA_STORE_ACTIONS.insert).not.toBe(DATA_STORE_ACTIONS.write);
    expect(DATA_STORE_OPERATION_RIGHTS.update).toBe(DATA_STORE_ACTIONS.execute);
    expect(DATA_STORE_OPERATION_RIGHTS.delete_rows).toBe(DATA_STORE_ACTIONS.execute);
    expect(DATA_STORE_OPERATION_RIGHTS.query).toBe("data_store.read");
    expect(DATA_STORE_ACTIONS).not.toHaveProperty("use");
    for (const action of [
      ...Object.values(WORKFLOW_ACTIONS),
      ...Object.values(DATA_STORE_ACTIONS),
      ...Object.values(KNOWLEDGE_BASE_ACTIONS)
    ]) {
      expect(ACTIONS, action).toContain(action);
    }
    // Workflow and Knowledge names are no data tool names an agent carries.
    expect(isDataToolName(dataStoreOperationName("s", "query"))).toBe(true);
    for (const name of [workflowStartOperationName("w"), KNOWLEDGE_QUERY_TOOL_NAME]) {
      expect(isDataToolName(name), name).toBe(false);
    }
  });

  // Fails without the conflict mode: a rerun of a Workflow stored every finding twice or failed
  // on the first one.
  it("fails an insert on a duplicate unless it is told to skip it", () => {
    expect(dataStoreInsertConflictSchema.parse(undefined)).toBe("fail");
    expect(dataStoreInsertConflictSchema.parse("skip")).toBe("skip");
    expect(dataStoreInsertConflictSchema.safeParse("update").success).toBe(false);
  });
});

describe("the modules workflows and dataStores", () => {
  it("are off unless a config turns them on", () => {
    const registry = createModuleRegistry([...platformModules, guardrailsModule]);
    const byDefault = registry.snapshot(
      resolveModuleSwitches(parseClientInstanceConfig(createTestConfig()))
    );
    expect(byDefault.isEnabled("workflows")).toBe(false);
    expect(byDefault.isEnabled("dataStores")).toBe(false);
    const on = registry.snapshot({ workflows: { enabled: true }, dataStores: { enabled: true } });
    expect(on.isEnabled("workflows")).toBe(true);
    expect(on.isEnabled("dataStores")).toBe(true);
  });

  it("own their kinds, operations and jobs, and hand the code step's jobs to the command worker", () => {
    expect(platformModules).toEqual(
      expect.arrayContaining([workflowsModule, dataStoresModule, knowledgeModule])
    );
    expect(knowledgeModule.requires).toEqual(["dataStores"]);
    // The script of a code step runs in the sandbox, which the command worker reaches.
    expect(workflowsModule.commandWorkerJobKinds).toEqual([
      "workflow_run.run_code",
      "workflow_run.sweep_code"
    ]);
    const off = createModuleRegistry(platformModules).snapshot({});
    expect(off.offModuleOf("kind", KNOWLEDGE_BASE_ASSET_KIND)).toBe("knowledge");
    expect(off.offModuleOf("operation", "knowledge_bases.query")).toBe("knowledge");
    // The one knowledge tool is no name an agent lists: it comes with the Knowledge Bases.
    expect(off.offModuleOf("tool", KNOWLEDGE_QUERY_TOOL_NAME)).toBeUndefined();
    expect(off.offModuleOf("kind", WORKFLOW_ASSET_KIND)).toBe("workflows");
    expect(off.offModuleOf("jobKind", WORKFLOW_RUN_JOB_KINDS.executeStep)).toBe("workflows");
    expect(off.offModuleOf("operation", "workflows.start")).toBe("workflows");
    expect(off.offModuleOf("kind", DATA_STORE_ASSET_KIND)).toBe("dataStores");
    expect(off.offModuleOf("jobKind", DATA_STORE_JOB_KINDS.provision)).toBe("dataStores");
  });
});

function stepTypes(step: WorkflowStep): WorkflowStep["type"][] {
  const lists =
    step.type === "loop"
      ? [step.steps]
      : step.type === "condition"
        ? [step.then, step.else ?? []]
        : step.type === "parallel"
          ? step.branches.map((branch) => branch.steps)
          : [];
  return [step.type, ...lists.flatMap((steps) => steps.flatMap(stepTypes))];
}
