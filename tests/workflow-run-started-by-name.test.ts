import { describe, expect, it, vi } from "vitest";
import {
  asClientInstanceId,
  asUserId,
  createOperationRegistry,
  createPlatformId,
  NoopAuditRecorder,
  type AuthenticatedUser,
  type OperationExecutionContext,
  type PlatformStores,
  type UserRecord,
  type WorkflowRunView
} from "@work-shape/catalyst-core";
import {
  createWorkflowRoutes,
  registerModuleOperations,
  type WorkflowRunsPort
} from "@work-shape/catalyst-server";

// ERASE-ACTOR-IDS: a Workflow Run names who started it as the account is now. The name stored
// with the run is a copy: a renamed person reads by their new name, and a person whose account
// is gone, or whose deletion was requested, by none, which the run page shows as "Deleted
// account".

const clientInstanceId = asClientInstanceId("workflow-run-names");
const viewer: AuthenticatedUser = {
  id: "viewer",
  externalUserId: "viewer",
  displayLabel: "Viewer",
  roles: ["admin"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};

const stamp = "2026-10-18T00:00:00.000Z";

function run(startedBy: WorkflowRunView["startedBy"]): WorkflowRunView {
  const id = createPlatformId<"WorkflowRunId">("wfr");
  return {
    id,
    clientInstanceId,
    workflow: "invoices",
    definitionRevisionId: "rev",
    mode: "live",
    trigger: "manual",
    status: "done",
    principal: {
      id: createPlatformId<"ServicePrincipalId">("sp"),
      name: "invoices",
      displayLabel: "Invoices account"
    },
    startedBy,
    rootRunId: id,
    depth: 0,
    stepRunCount: 0,
    deadlineAt: stamp,
    limits: { durationMs: 60_000, stepRuns: 10, loopItems: 10 },
    waitedMs: 0,
    correlationId: "corr",
    createdAt: stamp,
    hasAgentSteps: false
  };
}

function account(id: string, displayLabel: string, status: UserRecord["status"]): UserRecord {
  return {
    id: asUserId(id),
    clientInstanceId,
    displayLabel,
    roles: ["user"],
    permissionRefs: [],
    permissions: [],
    status,
    createdAt: stamp,
    updatedAt: stamp,
    identities: []
  };
}

async function readRun(stored: WorkflowRunView, users: readonly UserRecord[]) {
  const getUser = vi.fn<PlatformStores["users"]["getUser"]>(({ userId }) =>
    Promise.resolve(users.find((user) => user.id === userId))
  );
  const workflows: WorkflowRunsPort = {
    test: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    readRun: vi.fn<WorkflowRunsPort["readRun"]>().mockResolvedValue(stored),
    listRuns: vi.fn(),
    listStepRuns: vi.fn(),
    readStepTranscript: vi.fn(),
    listWorkflows: vi.fn(),
    assetOf: vi.fn<WorkflowRunsPort["assetOf"]>().mockResolvedValue(undefined)
  };
  const stores = {
    conversations: { getConversation: vi.fn(), createdAsset: vi.fn() },
    configAssets: { getConfigAsset: vi.fn().mockResolvedValue(undefined) },
    users: { getUser }
  };
  const registry = createOperationRegistry();
  registerModuleOperations(registry, [
    createWorkflowRoutes(workflows, { clientInstanceId, stores })
  ]);
  const binding = await registry.resolve("workflows.get_run");
  if (!binding) throw new Error("The Workflow run read is missing");
  const context: OperationExecutionContext = {
    actor: viewer,
    origin: { kind: "user" },
    runId: createPlatformId<"OperationRunId">("oprun"),
    correlationId: "correlation",
    runtime: {},
    access: {
      scopeOf: () => "all",
      authorize: () => ({ allowed: true, source: "grant" }),
      authorizeTransfer: () => ({ allowed: true, source: "grant" }),
      require: () => undefined,
      holdsGrantAt: () => true,
      denials: () => []
    },
    audit: new NoopAuditRecorder()
  };
  const read: unknown = await binding.execute({ runId: stored.id }, context);
  return typeof read === "object" && read !== null && "startedBy" in read
    ? read.startedBy
    : undefined;
}

describe("who started a Workflow Run (ERASE-ACTOR-IDS)", () => {
  // Fails without the change: the run answered the names stored with it.
  it("is named as the account is now, and by no name once it is gone", async () => {
    const renamed = "usr_7a1f6b0e-3d2c-4e8f-9b51-0c2d4e6f8a10";
    const leaving = "usr_2b9e4c61-5f0a-4d7e-8c3b-1a6f9e2d4b70";
    const gone = "usr_9c3d5e72-6a1b-4f8c-9d40-2b7e0f3a5c81";
    const users = [
      account(renamed, "Anna Neu", "active"),
      account(leaving, "Erika Mustermann", "deleting")
    ];
    const cases = [
      [renamed, "Anna Alt", "Anna Neu"],
      [leaving, "Erika Mustermann", ""],
      [gone, "Bernd Weg", ""]
    ] as const;
    for (const [id, stored, shown] of cases) {
      const startedBy = await readRun(run({ kind: "user", id, label: stored }), users);
      expect(startedBy).toEqual({ kind: "user", id, label: shown });
    }
    // A technical account keeps the name stored with the run.
    const scheduled = await readRun(
      run({ kind: "service_principal", id: "sp_schedule", label: "Schedule" }),
      users
    );
    expect(scheduled).toEqual({
      kind: "service_principal",
      id: "sp_schedule",
      label: "Schedule"
    });
  });
});
