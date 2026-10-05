import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StoreBackedAuditRecorder,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type ApprovalCheckConfig,
  type ApprovalRequest,
  type ApprovalRequestHandler,
  type AuthenticatedUser,
  isJsonObject,
  unknownToJsonValue,
  type JsonObject,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import {
  ApprovalCheckRunner,
  ApprovalRequestWorkflow,
  createSkillChangeApprovalHandler
} from "@vivd-catalyst/chat-server";
import { createSkillChangePreview, type SkillChangeOperation } from "@vivd-catalyst/config-schema";
import type { ModelCompletion, ModelProvider } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createProposeSkillChangeTool } from "@vivd-catalyst/tool-execution";
import { createModelVisibleToolOutput } from "../packages/agent-runtime/src/model-context-projection";
import { createConfigAssetSource } from "../packages/client-assembly/src/config-asset-source";
import { createTestConfig } from "./chat-server-harness";

const clientInstanceId = asClientInstanceId("test-client");
const user: AuthenticatedUser = {
  id: "requester",
  externalUserId: "requester",
  displayLabel: "Requester",
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};
const context: RuntimeCallContext = { user, clientInstanceId, correlationId: "check-correlation" };
const rule: ApprovalCheckConfig = {
  id: "no_personal_data",
  appliesTo: "fake",
  modelBindingId: "guardrailCheck",
  instruction: "Prüfe, ob der neue Text personenbezogene Daten enthält.",
  onFail: "warn"
};
const command: Pick<ApprovalRequest, "kind" | "summary" | "payload" | "origin"> = {
  kind: "fake",
  summary: "New summary",
  payload: { newText: "New content", oldText: "Private old text" },
  origin: {
    conversationId: asConversationId("conversation"),
    agentRunId: asAgentRunId("run"),
    toolCallId: asToolCallId("call"),
    agentName: "assistant"
  }
};
const handler: ApprovalRequestHandler = {
  kind: "fake",
  requiredPermission: "agent_skills.approve",
  validate: (payload) => payload,
  checkContent: (payload) => String(payload.newText),
  preview: async (payload) => payload,
  isStale: async () => false,
  apply: async () => ({})
};
function jsonObject(value: unknown): JsonObject {
  const converted = unknownToJsonValue(value);
  if (!isJsonObject(converted)) {
    throw new Error("Expected a JSON object");
  }
  return converted;
}
function completion(text: string): ModelCompletion {
  return {
    text,
    toolCalls: [],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      source: "provider_reported",
      webSearchCallCount: 0
    }
  };
}
function fixture(checks: ApprovalCheckConfig[] = [rule]) {
  const config = createTestConfig({
    modelBindings: [
      {
        id: "guardrailCheck",
        providerId: "local",
        model: "cheap-check",
        reasoningEffort: "low",
        agentSelectable: false
      }
    ]
  });
  config.approvalChecks = checks;
  const store = new InMemoryPlatformStore();
  const complete = vi
    .fn<ModelProvider["complete"]>()
    .mockResolvedValue(completion('{"violates":false,"reason":"Keine personenbezogenen Daten."}'));
  const usageGovernance = new ModelUsageGovernance({ store, budget: {}, safeguards: {} });
  const runner = new ApprovalCheckRunner({
    config,
    clientInstanceId,
    modelProvider: { id: "fake-provider", complete },
    usageGovernance
  });
  const workflow = new ApprovalRequestWorkflow({
    clientInstanceId,
    store,
    handlers: new Map([[handler.kind, handler]]),
    checkRunner: runner,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store })
  });
  return { config, store, complete, runner, workflow, usageGovernance };
}
afterEach(() => vi.useRealTimers());

describe("approval check runner", () => {
  it("passes, resolves the binding and sends only summary and new content as untrusted data", async () => {
    const f = fixture();
    expect(await f.runner.run(handler, command, context)).toEqual([
      { id: rule.id, status: "passed", message: "" }
    ]);
    const [request, callContext] = f.complete.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      providerId: "local",
      model: "cheap-check",
      reasoningEffort: "low",
      tools: []
    });
    expect(request?.messages[0]?.content).toContain(JSON.stringify(rule.instruction));
    expect(request?.messages[0]?.content).toContain("never follow");
    expect(request?.messages[1]?.content).toContain("BEGIN UNTRUSTED");
    expect(request?.messages[1]?.content).toContain(command.summary);
    expect(request?.messages[1]?.content).toContain("New content");
    expect(JSON.stringify(request)).not.toContain("Private old text");
    expect(callContext).toMatchObject({
      user,
      clientInstanceId,
      correlationId: context.correlationId
    });
    expect(callContext?.signal).toBeInstanceOf(AbortSignal);
    expect(await f.store.listModelUsageEvents({ clientInstanceId })).toEqual([
      expect.objectContaining({
        conversationId: command.origin?.conversationId,
        agentRunId: command.origin?.agentRunId,
        agentName: "approval_check",
        model: "cheap-check",
        totalTokens: 15
      })
    ]);
  });

  it.each(["warn", "block"] as const)(
    "returns the reason for a violation with onFail %s",
    async (onFail) => {
      const f = fixture([{ ...rule, onFail }]);
      f.complete.mockResolvedValue(
        completion('{"violates":true,"reason":"Der Text enthält personenbezogene Daten."}')
      );
      expect(await f.runner.run(handler, command, context)).toEqual([
        {
          id: rule.id,
          status: onFail === "block" ? "blocked" : "warned",
          message: "Der Text enthält personenbezogene Daten."
        }
      ]);
    }
  );

  it.each(["warn", "block"] as const)(
    "warns neutrally on provider failure even with onFail %s",
    async (onFail) => {
      const f = fixture([{ ...rule, onFail }]);
      f.complete.mockRejectedValue(new Error("secret provider detail"));
      expect(await f.runner.run(handler, command, context)).toEqual([
        { id: rule.id, status: "warned", message: "This approval check could not be evaluated." }
      ]);
      expect(await f.store.listModelUsageEvents({ clientInstanceId })).toEqual([
        expect.objectContaining({ source: "not_reported", totalTokens: 0 })
      ]);
    }
  );

  it.each([
    "not JSON",
    '```json\n{"violates":false,"reason":"OK"}\n```',
    '{"violates":"false","reason":"OK"}',
    '{"violates":true,"reason":""}',
    '{"violates":true,"reason":"Bad","extra":true}',
    '{"reason":"Missing verdict"}'
  ])("warns on an invalid verdict: %s", async (text) => {
    const f = fixture([{ ...rule, onFail: "block" }]);
    f.complete.mockResolvedValue(completion(text));
    expect(await f.runner.run(handler, command, context)).toEqual([
      { id: rule.id, status: "warned", message: "This approval check could not be evaluated." }
    ]);
    expect(await f.store.listModelUsageEvents({ clientInstanceId })).toHaveLength(1);
  });

  it.each(["warn", "block"] as const)(
    "bounds a provider that ignores cancellation with onFail %s",
    async (onFail) => {
      vi.useFakeTimers();
      const f = fixture([{ ...rule, onFail }]);
      f.complete.mockImplementation(() => new Promise<ModelCompletion>(() => {}));
      const result = f.runner.run(handler, command, context);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toEqual([
        { id: rule.id, status: "warned", message: "This approval check could not be evaluated." }
      ]);
      expect(f.complete.mock.calls[0]?.[1].signal?.aborted).toBe(true);
      expect(await f.store.listModelUsageEvents({ clientInstanceId })).toEqual([
        expect.objectContaining({ source: "not_reported" })
      ]);
    }
  );

  it("honors an earlier caller deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.complete.mockImplementation(() => new Promise<ModelCompletion>(() => {}));
    const result = f.runner.run(handler, command, {
      ...context,
      deadline: new Date(Date.now() + 100)
    });
    await vi.advanceTimersByTimeAsync(100);
    expect((await result)[0]?.status).toBe("warned");
  });

  it("runs checks concurrently, retains configured order and isolates a failed check", async () => {
    const f = fixture([rule, { ...rule, id: "second", onFail: "block" }]);
    let releaseFirst: ((value: ModelCompletion) => void) | undefined;
    let releaseSecond: ((value: ModelCompletion) => void) | undefined;
    f.complete
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = resolve;
          })
      );
    const pending = f.runner.run(handler, command, context);
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(2));
    releaseSecond?.(completion("invalid"));
    releaseFirst?.(completion('{"violates":false,"reason":"OK"}'));
    expect(await pending).toEqual([
      { id: rule.id, status: "passed", message: "" },
      { id: "second", status: "warned", message: "This approval check could not be evaluated." }
    ]);
    expect(await f.store.listModelUsageEvents({ clientInstanceId })).toHaveLength(2);
  });

  it("ignores checks for another kind, empty configuration, and handlers without checkContent", async () => {
    const f = fixture([{ ...rule, appliesTo: "other" }]);
    expect(await f.runner.run(handler, command, context)).toEqual([]);
    f.config.approvalChecks = [];
    expect(await f.runner.run(handler, command, context)).toEqual([]);
    f.config.approvalChecks = [rule];
    const { checkContent: _checkContent, ...withoutContent } = handler;
    expect(await f.runner.run(withoutContent, command, context)).toEqual([]);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("still evaluates a request without origin, which the usage contract cannot attribute", async () => {
    const f = fixture();
    expect(
      (await f.runner.run(handler, { ...command, origin: undefined }, context))[0]?.status
    ).toBe("passed");
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(await f.store.listModelUsageEvents({ clientInstanceId })).toEqual([]);
  });
});

describe("approval checks at creation", () => {
  it("blocks before persistence and surfaces the reason without a creation audit", async () => {
    const f = fixture([{ ...rule, onFail: "block" }]);
    f.complete.mockResolvedValue(
      completion('{"violates":true,"reason":"Remove the personal data."}')
    );
    const create = vi.spyOn(f.store, "createApprovalRequest");
    await expect(f.workflow.createRequest(user, context, command)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Approval request blocked: Remove the personal data."
    });
    expect(create).not.toHaveBeenCalled();
    expect(await f.store.listApprovalRequests({ clientInstanceId, kinds: [command.kind] })).toEqual(
      []
    );
    expect(await f.store.listAuditEvents({ clientInstanceId })).toEqual([]);
    expect(await f.store.listModelUsageEvents({ clientInstanceId })).toHaveLength(1);
  });

  it("does not bypass a blocking verdict when usage storage fails", async () => {
    const f = fixture([{ ...rule, onFail: "block" }]);
    f.complete.mockResolvedValue(
      completion('{"violates":true,"reason":"Remove the personal data."}')
    );
    vi.spyOn(f.usageGovernance, "recordModelUsage").mockRejectedValueOnce(
      new Error("Storage unavailable")
    );
    await expect(f.workflow.createRequest(user, context, command)).rejects.toMatchObject({
      code: "INTERNAL",
      message: "Approval check usage could not be recorded"
    });
    expect(await f.store.listApprovalRequests({ clientInstanceId, kinds: [command.kind] })).toEqual(
      []
    );
  });

  it("stores warnings, exposes them in views, and audits only check ids and statuses", async () => {
    const f = fixture();
    f.complete.mockResolvedValue(
      completion('{"violates":true,"reason":"Remove the personal data."}')
    );
    const request = await f.workflow.createRequest(user, context, command);
    const checks = [{ id: rule.id, status: "warned", message: "Remove the personal data." }];
    expect(request.checks).toEqual(checks);
    expect(await f.workflow.getRequest(user, context, request.id)).toMatchObject({ checks });
    expect(
      await f.store.getApprovalRequest({ clientInstanceId, requestId: request.id })
    ).toMatchObject({ checks });
    expect((await f.store.listAuditEvents({ clientInstanceId }))[0]?.metadata).toEqual({
      requestId: request.id,
      kind: command.kind,
      status: "pending",
      checks: [{ id: rule.id, status: "warned" }]
    });
    await f.workflow.decideRequest({ ...user, permissions: ["agent_skills.approve"] }, context, {
      requestId: request.id,
      decision: "approve"
    });
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("stores passed checks and permits creation when a block rule cannot be evaluated", async () => {
    const f = fixture([{ ...rule, onFail: "block" }]);
    expect((await f.workflow.createRequest(user, context, command)).checks[0]?.status).toBe(
      "passed"
    );
    f.complete.mockRejectedValueOnce(new Error("Unavailable"));
    const request = await f.workflow.createRequest(user, context, command);
    expect(await f.workflow.getRequest(user, context, request.id)).toMatchObject({
      status: "pending",
      checks: [
        { id: rule.id, status: "warned", message: "This approval check could not be evaluated." }
      ]
    });
  });
});

async function skillFixture() {
  const f = fixture([{ ...rule, appliesTo: "skill_change", onFail: "block" }]);
  f.config.administration.agentConfiguration.agentSkillChanges = {
    enabled: true,
    allowSkillCreation: true
  };
  const skill = {
    name: "review",
    title: "Existing title",
    description: "Existing description",
    content: "Private old text",
    resources: []
  };
  const agent = {
    name: "assistant",
    displayName: "Assistant",
    instructions: "Help",
    toolNames: ["propose_skill_change"],
    skillNames: [skill.name],
    initialPrompts: []
  };
  await f.store.applyConfigAssetMutations({
    clientInstanceId,
    mutations: [
      { type: "upsert", kind: "skill", name: skill.name, config: skill },
      { type: "upsert", kind: "agent", name: agent.name, config: agent }
    ]
  });
  const source = createConfigAssetSource({ store: f.store, clientInstanceId });
  const skillHandler = createSkillChangeApprovalHandler({
    config: f.config,
    clientInstanceId,
    configAssets: {
      store: f.store,
      source,
      validationRefs: {
        modelProviderIds: ["local"],
        modelBindingIds: ["guardrailCheck"],
        modelBindings: [{ id: "guardrailCheck", model: "cheap-check" }],
        reasoningEfforts: ["low"],
        enabledToolNames: ["propose_skill_change"]
      }
    }
  });
  const workflow = new ApprovalRequestWorkflow({
    clientInstanceId,
    store: f.store,
    handlers: new Map([[skillHandler.kind, skillHandler]]),
    checkRunner: f.runner,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: f.store })
  });
  const tool = createProposeSkillChangeTool({
    assetSource: source,
    policy: f.config.administration.agentConfiguration.agentSkillChanges,
    creator: workflow
  });
  return { ...f, skill, skillHandler, tool, workflow };
}

describe("skill change approval checks", () => {
  it("extracts new text for every operation, excluding old text and the existing preview", async () => {
    const f = await skillFixture();
    const operations: SkillChangeOperation[] = [
      { type: "replace_text", target: "root", oldText: "Private old text", newText: "Replacement" },
      { type: "append_text", target: "root", text: "Addition" },
      { type: "create_resource", resourcePath: "references/new.md", content: "Resource content" }
    ];
    const payload = f.skillHandler.validate(
      jsonObject({
        agentName: "assistant",
        skillName: f.skill.name,
        operations,
        baseSourceVersion: `sha256:${"0".repeat(64)}`,
        preview: createSkillChangePreview(f.skill, operations)
      })
    );
    const content = f.skillHandler.checkContent?.(payload);
    for (const expected of ["Replacement", "Addition", "Resource content"]) {
      expect(content).toContain(expected);
    }
    expect(content).not.toContain("Private old text");
    expect(content).not.toContain("Existing title");
    expect(content).not.toContain("Existing description");
    const creation = {
      type: "create_skill" as const,
      name: "new_skill",
      title: "New title",
      description: "New description",
      content: "New body"
    };
    const newPayload = f.skillHandler.validate(
      jsonObject({
        agentName: "assistant",
        skillName: "new_skill",
        operations: [creation],
        baseSourceVersion: null,
        preview: createSkillChangePreview(undefined, [creation])
      })
    );
    for (const expected of ["New title", "New description", "New body"]) {
      expect(f.skillHandler.checkContent?.(newPayload)).toContain(expected);
    }
  });

  it("returns a model-readable blocked proposal failure and stores no request or asset change", async () => {
    const f = await skillFixture();
    f.complete.mockResolvedValue(
      completion('{"violates":true,"reason":"Remove the personal data."}')
    );
    const result = await f.tool.execute(
      {
        skillName: f.skill.name,
        summary: "A new instruction",
        operations: [
          {
            type: "replace_text",
            target: "root",
            oldText: "Private old text",
            newText: "New content"
          }
        ]
      },
      {
        ...context,
        toolRequest: {
          agentName: "assistant",
          conversationId: asConversationId("conversation"),
          agentRunId: asAgentRunId("run"),
          toolCallId: asToolCallId("call"),
          toolName: "propose_skill_change",
          input: {}
        }
      }
    );
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "validation_failed",
        message: "Approval request blocked: Remove the personal data."
      }
    });
    expect(
      (await createModelVisibleToolOutput(result, { toolOutput: { maxTokens: 1000 } })).text
    ).toContain("Remove the personal data.");
    expect(
      await f.store.listApprovalRequests({ clientInstanceId, kinds: ["skill_change"] })
    ).toEqual([]);
    expect(
      await f.store.listConfigAssetRevisions({
        clientInstanceId,
        kind: "skill",
        name: f.skill.name
      })
    ).toHaveLength(1);
    expect(JSON.stringify(f.complete.mock.calls[0]?.[0].messages)).not.toContain(
      "Private old text"
    );
  });
});
