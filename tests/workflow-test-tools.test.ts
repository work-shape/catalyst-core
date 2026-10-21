import { describe, expect, it, vi } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  createPlatformId,
  asToolCallId,
  createOperationRegistry,
  createModuleRegistry,
  NoopAuditRecorder,
  resolvePolicy,
  type AuthenticatedUser,
  type Conversation,
  type OperationExecutionContext,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { createPlatformTools, platformModules } from "@work-shape/catalyst-client-assembly";
import {
  createWorkflowRoutes,
  registerModuleOperations,
  type WorkflowRunsPort
} from "@work-shape/catalyst-server";
import {
  createWorkflowTestTools,
  registerToolOperations,
  WORKFLOW_TEST_TOOL_NAMES
} from "@work-shape/catalyst-tool-execution";

const clientInstanceId = asClientInstanceId("workflow-test-tools");
const user: AuthenticatedUser = {
  id: "tester",
  externalUserId: "tester",
  displayLabel: "Tester",
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};
const conversation: Conversation = {
  id: asConversationId("conversation"),
  clientInstanceId,
  collaborationWorkspaceId: asCollaborationWorkspaceId("workspace"),
  createdByUserId: user.id,
  createdByExternalUserId: user.externalUserId,
  kind: "chat",
  visibility: "private",
  status: "active",
  title: "Build",
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
  retainedUntil: "2026-11-17T00:00:00.000Z",
  subject: { kind: "workflow", name: "subject-workflow" }
};

async function fixture() {
  const getConversation = vi
    .fn<PlatformStores["conversations"]["getConversation"]>()
    .mockResolvedValue(conversation);
  // The Workflow drafts the conversation created (BUILD-ALL-1): none unless a test says so.
  const createdAsset = vi
    .fn<PlatformStores["conversations"]["createdAsset"]>()
    .mockResolvedValue(false);
  // Only these methods may be reached: any other store access fails the unit probe.
  const stores = {
    conversations: { getConversation, createdAsset },
    // A failure's Connection is titled from its asset; this probe names none.
    configAssets: { getConfigAsset: vi.fn().mockResolvedValue(undefined) }
  };
  const test = vi.fn<WorkflowRunsPort["test"]>().mockRejectedValue(new Error("engine reached"));
  const workflows: WorkflowRunsPort = {
    test,
    start: vi.fn(),
    cancel: vi.fn(),
    readRun: vi.fn(),
    listRuns: vi.fn(),
    listStepRuns: vi.fn(),
    readStepTranscript: vi.fn(),
    listWorkflows: vi.fn(),
    assetOf: vi.fn()
  };
  const registry = createOperationRegistry();
  registerModuleOperations(registry, [
    createWorkflowRoutes(workflows, { clientInstanceId, stores })
  ]);
  const binding = await registry.resolve("workflows.test");
  if (!binding) throw new Error("The Workflow test operation is missing");
  const context: OperationExecutionContext = {
    actor: user,
    origin: {
      kind: "agent",
      agentName: "builder",
      agentRunId: asAgentRunId("agent-run"),
      conversationId: conversation.id,
      toolCallId: asToolCallId("tool-call"),
      toolName: "workflows.test"
    },
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
  return { binding, context, test, stores, getConversation, createdAsset, workflows };
}

describe("the agent projections of Workflow testing", () => {
  it("offers only test and result reads to platform agents, and hides them with the module off", async () => {
    const t = await fixture();
    for (const enabled of [true, false]) {
      const modules = createModuleRegistry(platformModules).snapshot({ workflows: { enabled } });
      const platform = createPlatformTools({ stores: t.stores, modules });
      const registry = platform.registry(platform.tools, new Set());
      for (const agentToolNames of [["platform.assets.get"], []]) {
        const offer = await platform.conversationOffer.offerOf({
          clientInstanceId,
          conversationId: conversation.id,
          agentToolNames
        });
        expect(offer?.toolNames.filter((name) => name.startsWith("workflows."))).toEqual(
          enabled && agentToolNames.length > 0 ? WORKFLOW_TEST_TOOL_NAMES : []
        );
        expect(offer?.toolNames).not.toContain("assets.run_live_once");
        expect(offer?.toolNames).not.toContain("workflows.start");
      }
      expect(registry.has("workflows.test")).toBe(enabled);
      expect(registry.has("assets.run_live_once")).toBe(false);
    }
  });

  it("keeps the native operations' rights and validation rather than registering tool replacements", async () => {
    const registry = createOperationRegistry();
    registerToolOperations(registry, createWorkflowTestTools(), { clientInstanceId });
    expect((await registry.list()).operations).toEqual([]);
  });

  it("registers the same validated operations in a worker without HTTP", async () => {
    const { stores, workflows } = await fixture();
    const registry = createOperationRegistry();
    registerModuleOperations(registry, [
      createWorkflowRoutes(workflows, { clientInstanceId, stores })
    ]);
    const test = await registry.resolve("workflows.test");
    expect(test).toMatchObject({
      name: "workflows.test",
      defaultPolicy: "allow",
      module: "workflows"
    });
    expect(test?.inputSchema.safeParse({ workflow: 42, input: [] }).success).toBe(false);
    expect(test?.inputSchema.safeParse({ workflow: "subject-workflow", input: {} }).success).toBe(
      true
    );
    for (const operation of ["workflows.get_run", "workflows.list_step_runs"]) {
      const read = await registry.resolve(operation);
      expect(read).toMatchObject({ effect: "reading", module: "workflows" });
      expect(read?.recordsEveryCall).toBeUndefined();
    }
    expect(await registry.resolve("assets.run_live_once")).toBeUndefined();
  });

  it("declares allow for the real test operation, with central policy still able to tighten it", async () => {
    const { binding, context } = await fixture();
    const policy = {
      definition: {
        name: "workflows.test",
        effect: "changing",
        defaultPolicy: binding.defaultPolicy
      },
      origin: context.origin,
      instanceDefaults: { reading: "allow", changing: "confirm" },
      centralSettings: [],
      callerCanConfirm: false,
      canPause: true
    } as const;
    expect(resolvePolicy(policy)).toEqual({
      value: "allow",
      next: "run",
      source: "declared_default"
    });
    expect(
      resolvePolicy({
        ...policy,
        centralSettings: [{ operation: "workflows.test", value: "deny" }]
      })
    ).toMatchObject({ next: "refuse" });
  });

  it("dispatches its subject as the person, preserving the agent operation's run for the engine", async () => {
    const { binding, context, test } = await fixture();
    await expect(
      binding.execute({ workflow: "subject-workflow", input: { note: "test" } }, context)
    ).rejects.toThrow("engine reached");
    expect(test).toHaveBeenCalledExactlyOnceWith({
      workflow: "subject-workflow",
      input: { note: "test" },
      startedBy: user,
      operationRunId: context.runId,
      correlationId: context.correlationId,
      // An agent's test runs the draft; only an App's draft may run the published revision.
      revision: "draft"
    });
  });

  it.each([
    { ...conversation, subject: { kind: "workflow", name: "another-workflow" } },
    { ...conversation, subject: { kind: "app", name: "subject-workflow" } },
    { ...conversation, subject: undefined },
    { ...conversation, status: "deleted" as const },
    undefined
  ])(
    "refuses a non-subject, wrong-kind, absent or deleted conversation at dispatch",
    async (current) => {
      const { binding, context, test, getConversation } = await fixture();
      getConversation.mockResolvedValue(current);
      await expect(
        binding.execute({ workflow: "subject-workflow", input: {} }, context)
      ).rejects.toMatchObject({ code: "FORBIDDEN", details: { reason: "workflow_not_subject" } });
      expect(test).not.toHaveBeenCalled();
    }
  );

  it("dispatches a Workflow draft the conversation created beside its subject, and no other", async () => {
    const { binding, context, test, getConversation, createdAsset } = await fixture();
    // The conversation is about an App; it created the Workflow the App needs (BUILD-ALL-1).
    getConversation.mockResolvedValue({ ...conversation, subject: { kind: "app", name: "desk" } });
    createdAsset.mockImplementation(({ kind, name }) =>
      Promise.resolve(kind === "workflow" && name === "created-workflow")
    );
    await expect(
      binding.execute({ workflow: "created-workflow", input: {} }, context)
    ).rejects.toThrow("engine reached");
    expect(createdAsset).toHaveBeenCalledWith({
      clientInstanceId,
      conversationId: conversation.id,
      kind: "workflow",
      name: "created-workflow"
    });
    test.mockClear();
    await expect(
      binding.execute({ workflow: "existing-workflow", input: {} }, context)
    ).rejects.toMatchObject({ code: "FORBIDDEN", details: { reason: "workflow_not_subject" } });
    expect(test).not.toHaveBeenCalled();
  });

  it("uses the person's Workflow write right, even if an agent lists the tool", async () => {
    const { binding, context } = await fixture();
    const authorize = vi.fn().mockReturnValue({ allowed: false, reason: "no_grant" });
    const decision = await binding.authorize?.(
      { workflow: "subject-workflow", input: {} },
      {
        ...context,
        resource: undefined,
        access: {
          ...context.access,
          authorize
        }
      }
    );
    expect(decision).toMatchObject({ allowed: false, action: "workflow.write" });
    expect(authorize).toHaveBeenCalledWith("workflow.write", {
      kind: "workflow",
      name: "subject-workflow"
    });
  });

  it("refuses a different subject before policy can prompt and rechecks after admission", async () => {
    const { binding, context, getConversation, test } = await fixture();
    const input = { workflow: "subject-workflow", input: {} };
    const another = { ...conversation, subject: { kind: "workflow", name: "another" } };
    getConversation.mockResolvedValue(another);
    await expect(
      binding.authorize?.(input, { ...context, resource: undefined })
    ).rejects.toMatchObject({ code: "FORBIDDEN", details: { reason: "workflow_not_subject" } });
    getConversation.mockResolvedValue(conversation);
    expect(await binding.authorize?.(input, { ...context, resource: undefined })).toEqual({
      allowed: true
    });
    getConversation.mockResolvedValue(another);
    await expect(binding.execute(input, context)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "workflow_not_subject" }
    });
    expect(test).not.toHaveBeenCalled();
  });

  it("still lets a person test another Workflow directly", async () => {
    const { binding, context, getConversation } = await fixture();
    await expect(
      binding.execute(
        { workflow: "other-workflow", input: {} },
        { ...context, origin: { kind: "user" } }
      )
    ).rejects.toThrow("engine reached");
    expect(getConversation).not.toHaveBeenCalled();
  });
});
