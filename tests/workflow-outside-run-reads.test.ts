import { describe, expect, it, vi } from "vitest";
import {
  AppError,
  asClientInstanceId,
  createOperationRegistry,
  createPlatformId,
  NoopAuditRecorder,
  type AuthenticatedUser,
  type OperationExecutionContext,
  type WorkflowRunView,
  type WorkflowStepRunView
} from "@work-shape/catalyst-core";
import {
  createWorkflowRoutes,
  registerModuleOperations,
  type WorkflowRunsPort
} from "@work-shape/catalyst-server";

const clientInstanceId = asClientInstanceId("outside-run-reads");
const stamp = "2026-10-27T00:00:00.000Z";
const data = "value-from-the-connection";
const preview = { text: data, truncated: false };
const key = {
  kind: "api_key" as const,
  id: createPlatformId<"ApiCredentialId">("key"),
  displayLabel: "Reader key",
  authSource: "test"
};
const viewer: AuthenticatedUser = {
  id: "reader",
  externalUserId: "reader",
  displayLabel: "Reader",
  roles: [],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test",
  delegatedActor: key
};

function run(workflow: string, trigger: WorkflowRunView["trigger"]): WorkflowRunView {
  const id = createPlatformId<"WorkflowRunId">("wfr");
  return {
    id,
    clientInstanceId,
    workflow,
    definitionRevisionId: "revision",
    mode: "live",
    trigger,
    status: "done",
    principal: {
      id: createPlatformId<"ServicePrincipalId">("sp"),
      name: "runner",
      displayLabel: "Runner"
    },
    startedBy: { kind: "user", id: viewer.id, label: "Reader", delegatedActor: key },
    rootRunId: id,
    depth: 0,
    stepRunCount: 1,
    deadlineAt: stamp,
    limits: { durationMs: 60_000, stepRuns: 10, loopItems: 10 },
    waitedMs: 0,
    correlationId: "correlation",
    createdAt: stamp,
    outputPreview: preview,
    labels: { client: data },
    runKey: data,
    hasAgentSteps: true
  };
}

function setup(rootTrigger: WorkflowRunView["trigger"] = "outside") {
  const root = run("parent", rootTrigger);
  const child = { ...run("child", "parent"), rootRunId: root.id, depth: 1 };
  const stored = new Map<string, WorkflowRunView>([
    [root.id, root],
    [child.id, child]
  ]);
  const step: WorkflowStepRunView = {
    id: createPlatformId<"WorkflowStepRunId">("wfs"),
    clientInstanceId,
    runId: child.id,
    stepId: "read",
    stepType: "operation",
    key: "read",
    status: "done",
    attempt: 1,
    createdAt: stamp,
    inputPreview: preview,
    outputPreview: preview
  };
  const workflows: WorkflowRunsPort = {
    start: vi.fn().mockResolvedValue(child),
    test: vi.fn().mockResolvedValue(child),
    cancel: vi.fn().mockResolvedValue(child),
    readRun: vi.fn<WorkflowRunsPort["readRun"]>((id) => Promise.resolve(stored.get(id))),
    listRuns: vi.fn().mockResolvedValue([child]),
    listStepRuns: vi.fn().mockResolvedValue([step]),
    readStepTranscript: vi.fn().mockResolvedValue({ messages: [{ text: data }] }),
    downloadDataset: vi.fn().mockResolvedValue({ content: data }),
    listWorkflows: vi.fn(),
    assetOf: vi.fn().mockResolvedValue(undefined)
  };
  const registry = createOperationRegistry();
  registerModuleOperations(registry, [
    createWorkflowRoutes(workflows, {
      clientInstanceId,
      stores: {
        conversations: { getConversation: vi.fn(), createdAsset: vi.fn() },
        configAssets: { getConfigAsset: vi.fn().mockResolvedValue(undefined) }
      }
    })
  ]);
  const context: OperationExecutionContext = {
    actor: viewer,
    origin: { kind: "cli" },
    runId: createPlatformId<"OperationRunId">("oprun"),
    correlationId: "correlation",
    runtime: {},
    audit: new NoopAuditRecorder(),
    access: {
      scopeOf: () => "all",
      authorize: () => ({ allowed: true, source: "grant" }),
      authorizeTransfer: () => ({ allowed: true, source: "grant" }),
      require: () => undefined,
      holdsGrantAt: () => true,
      denials: () => []
    }
  };
  async function call(name: string, input: unknown) {
    const binding = await registry.resolve(name);
    if (!binding) throw new Error(`Missing ${name}`);
    const decision = await binding.authorize?.(input, { ...context, resource: undefined });
    if (decision && !decision.allowed) return decision;
    try {
      return await binding.execute(input, context);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "FORBIDDEN") throw error;
      return { code: error.code, details: error.details };
    }
  }
  return { root, child, stored, context, call, workflows, step };
}

const reads = [
  ["workflows.get_run", (id: string) => ({ runId: id })],
  ["workflows.list_runs", () => ({ workflow: "child" })],
  ["workflows.list_step_runs", (id: string) => ({ runId: id })],
  ["workflows.start", () => ({ workflow: "child", input: {}, key: "existing" })],
  ["workflows.test", () => ({ workflow: "child", input: {}, revision: "draft" })],
  ["workflows.cancel_run", (id: string) => ({ runId: id })],
  [
    "workflows.download_dataset",
    (id: string) => ({ runId: id, datasetId: "dataset", format: "json" })
  ],
  ["workflows.get_step_transcript", (id: string) => ({ runId: id, stepRunId: "step" })]
] as const;

// The HTTP operations share these bindings. A child's trigger is parent; its root decides
// whether the outside boundary was checked. Existing rights and test-key ownership still bind.
describe("outside reads of a child run", () => {
  it("answers every read path under an outside-started root", async () => {
    const t = setup();
    for (const [name, input] of reads) {
      expect(JSON.stringify(await t.call(name, input(t.child.id))), name).toContain(data);
    }
    // Nothing is decided from the child's trigger alone.
    expect(t.child.trigger).toBe("parent");
  });

  it.each(["manual", "schedule"] as const)(
    "strips or refuses every read under a %s root",
    async (trigger) => {
      const t = setup(trigger);
      // Even a child claiming outside cannot override its root.
      t.child.trigger = "outside";
      for (const [name, input] of reads) {
        expect(JSON.stringify(await t.call(name, input(t.child.id))), name).not.toContain(data);
      }
      expect(t.workflows.downloadDataset).not.toHaveBeenCalled();
      expect(t.workflows.readStepTranscript).not.toHaveBeenCalled();
    }
  );

  it("shows another credential a child's data only where it may read the root's", async () => {
    const t = setup();
    const onlyOn =
      (...workflows: string[]): OperationExecutionContext["access"]["authorize"] =>
      (_action, resource) =>
        workflows.includes(resource?.name ?? "")
          ? { allowed: true, source: "grant" }
          : { allowed: false, reason: "no_grant" };
    // The credential that started the root reads its child with rights on the child alone.
    t.context.access.authorize = onlyOn("child");
    for (const [name, input] of reads) {
      expect(JSON.stringify(await t.call(name, input(t.child.id))), name).toContain(data);
    }
    t.context.actor = {
      ...viewer,
      id: "other",
      delegatedActor: { ...key, id: createPlatformId<"ApiCredentialId">("key") }
    };
    for (const [name, input] of reads) {
      expect(JSON.stringify(await t.call(name, input(t.child.id))), name).not.toContain(data);
    }
    t.context.access.authorize = onlyOn("child", "parent");
    for (const [name, input] of reads) {
      expect(JSON.stringify(await t.call(name, input(t.child.id))), name).toContain(data);
    }
  });

  it("reads a root shared by listed children once", async () => {
    const t = setup();
    const sibling = { ...t.child, id: createPlatformId<"WorkflowRunId">("wfr") };
    t.stored.set(sibling.id, sibling);
    vi.mocked(t.workflows.listRuns).mockResolvedValue([t.child, sibling]);
    vi.mocked(t.workflows.readRun).mockClear();
    expect(JSON.stringify(await t.call("workflows.list_runs", { workflow: "child" }))).toContain(
      data
    );
    expect(vi.mocked(t.workflows.readRun).mock.calls).toEqual([[t.root.id]]);
  });

  it("fails closed when the root is missing", async () => {
    const t = setup();
    t.stored.delete(t.root.id);
    for (const [name, input] of reads) {
      expect(JSON.stringify(await t.call(name, input(t.child.id))), name).not.toContain(data);
    }
  });

  it("keeps test runs bound to the same credential and preserves child run-data rights", async () => {
    const t = setup();
    t.child.mode = "test";
    for (const [name, input] of reads) {
      expect(JSON.stringify(await t.call(name, input(t.child.id))), name).toContain(data);
    }
    t.context.actor = {
      ...viewer,
      delegatedActor: { ...key, id: createPlatformId<"ApiCredentialId">("key") }
    };
    for (const [name, input] of reads) {
      expect(JSON.stringify(await t.call(name, input(t.child.id))), name).not.toContain(data);
    }
    t.child.mode = "live";
    t.context.access.authorize = (action) =>
      action === "workflow.read_run_data"
        ? { allowed: false, reason: "no_grant" }
        : { allowed: true, source: "grant" };
    for (const [name, input] of reads) {
      expect(JSON.stringify(await t.call(name, input(t.child.id))), name).not.toContain(data);
    }
    // The same result as the root's reader; becoming a child lends no right.
    expect(JSON.stringify(await t.call("workflows.get_run", { runId: t.root.id }))).not.toContain(
      data
    );
  });
});
