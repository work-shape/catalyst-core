import { createTestInstance } from "./support/test-instance";
import { describe, expect, it } from "vitest";
import {
  StoreBackedAuditRecorder,
  asAgentRunId,
  asClientInstanceId,
  asToolCallId,
  approvalDecisionNote,
  approvalRevisionOwner,
  createApprovalDecisionMessage,
  readApprovalDecisionMetadata,
  readAgentRuntimeMessageMetadata,
  type ApprovalRequest,
  type ApprovalRequestStatus,
  type AuthenticatedUser,
  type ModelProviderConfig
} from "@vivd-catalyst/core";
import { createStaticConfigAssetSource } from "@vivd-catalyst/core/testing";
import { ApprovalRequestWorkflow } from "@vivd-catalyst/chat-server";
import { LocalAgentRuntime } from "@vivd-catalyst/agent-runtime";
import { type ModelProvider } from "@vivd-catalyst/model-provider";
import { ToolRegistry } from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { messageSchema } from "@vivd-catalyst/api-contract";
import {
  dropCurrentSubmittedMessage,
  projectAgentVisibleHistory,
  selectRecentCompleteHistory
} from "../packages/agent-runtime/src/model-context-projection";

const clientInstanceId = asClientInstanceId("decision-test");
const owner: AuthenticatedUser = {
  id: "owner",
  externalUserId: "owner",
  displayLabel: "Owner",
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};
const reviewer: AuthenticatedUser = {
  ...owner,
  id: "reviewer",
  displayLabel: "Reviewer",
  permissions: ["agent_skills.approve"]
};
const context = { clientInstanceId, correlationId: "decision-test", user: owner };
const usage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  source: "not_reported" as const,
  webSearchCallCount: 0
};

async function fixture() {
  const store = createTestInstance().stores;
  const conversation = await store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: owner.id,
    createdByExternalUserId: owner.externalUserId,
    title: "Decisions",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const handler = {
    kind: "skill_change",
    requiredPermission: "agent_skills.approve" as const,
    validate: (payload: ApprovalRequest["payload"]) => payload,
    preview: async () => ({}),
    isStale: async () => false,
    apply: async () => ({ secret: "PRIVATE_APPLY_RESULT" }),
    revert: async () => ({})
  };
  const workflow = new ApprovalRequestWorkflow({
    clientInstanceId,
    store: store.approvals,
    handlers: new Map([[handler.kind, handler]]),
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit }),
    onDecided: (request) => store.approvals.appendApprovalDecision(request)
  });
  const create = () =>
    workflow.createRequest(owner, context, {
      kind: handler.kind,
      summary: "Check all pages",
      payload: { skillText: "PRIVATE_SKILL_TEXT" },
      origin: {
        conversationId: conversation.id,
        agentRunId: asAgentRunId("origin-run"),
        toolCallId: asToolCallId("origin-call"),
        agentName: "agent"
      }
    });
  const messages = () =>
    store.conversations.listMessages({ clientInstanceId, conversationId: conversation.id });
  return { store, conversation, workflow, handler, create, messages };
}

describe("approval decision history", () => {
  it.each<Exclude<ApprovalRequestStatus, "pending">>([
    "approved",
    "rejected",
    "changes_requested",
    "superseded",
    "withdrawn",
    "reverted"
  ])("records %s once with the actor and only the public decision fields", async (status) => {
    const f = await fixture();
    const request = await f.create();
    f.handler.isStale = async () => status === "superseded";
    const decided =
      status === "withdrawn"
        ? await f.workflow.withdrawRequest(owner, context, request.id)
        : await f.workflow.decideRequest(reviewer, context, {
            requestId: request.id,
            decision:
              status === "rejected"
                ? "reject"
                : status === "changes_requested"
                  ? "request_changes"
                  : "approve",
            comment: "Please check the appendix"
          });
    const result =
      status === "reverted"
        ? await f.workflow.revertRequest(
            { ...reviewer, id: "reverter", displayLabel: "Reverter" },
            context,
            request.id
          )
        : decided;
    await Promise.all([
      f.store.approvals.appendApprovalDecision(result),
      f.store.approvals.appendApprovalDecision(result)
    ]);
    const messages = await f.messages();
    expect(messages).toHaveLength(status === "reverted" ? 2 : 1);
    const event = readApprovalDecisionMetadata(messages.at(-1)?.metadata);
    expect(event).toMatchObject({
      kind: "approval_decision",
      requestId: request.id,
      requestKind: "skill_change",
      status,
      summary: request.summary,
      decidedByLabel:
        status === "withdrawn" ? "Owner" : status === "reverted" ? "Reverter" : "Reviewer",
      decidedAt: expect.any(String)
    });
    expect(messageSchema.parse(messages.at(-1)).metadata?.agentRuntime).toEqual(event);
    expect(JSON.stringify(messages)).not.toContain("PRIVATE_");
    expect(messages.at(-1)?.text).toContain(
      status === "approved" ? "change is now active" : status
    );
    expect(event?.requestedBy).toBe(owner.id);
    if (status === "changes_requested") {
      expect(messages.at(-1)?.text).toContain("The reviewer has taken over the revision");
      expect(messages.at(-1)?.text).not.toContain("When the user continues");
    }
    if (status === "reverted") {
      expect(event?.comment).toBeUndefined();
    }
  });

  it("lets the origin agent revise only a proposal its own requester sent back", async () => {
    const f = await fixture();
    const ownerWhoApproves = { ...owner, permissions: ["agent_skills.approve" as const] };
    const own = await f.workflow.decideRequest(ownerWhoApproves, context, {
      requestId: (await f.create()).id,
      decision: "request_changes",
      comment: "Shorter"
    });
    const taken = await f.workflow.decideRequest(reviewer, context, {
      requestId: (await f.create()).id,
      decision: "request_changes",
      comment: "Without names"
    });
    const notes = (await f.messages()).map((message) => message.text);

    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain(own.id);
    expect(notes[0]).toContain(
      "When the user continues, submit a revised proposal addressing the requested changes."
    );
    expect(notes[0]).not.toContain("taken over");
    expect(notes[1]).toContain(taken.id);
    expect(notes[1]).toContain("The reviewer has taken over the revision");
    expect(notes[1]).toContain(
      "Do NOT submit a revised proposal in this conversation unless the user explicitly asks for one."
    );
    expect(notes[1]).toContain('Comment: "Without names"');
  });

  it("reads a decision stored without its requester as the requester's own revision", () => {
    const stored = {
      version: 1,
      kind: "approval_decision",
      requestId: "apr_old",
      requestKind: "skill_change",
      status: "changes_requested",
      decidedBy: "reviewer",
      decidedByLabel: "Reviewer",
      decidedAt: "2026-10-05T09:00:00.000Z",
      summary: "Check all pages"
    } as const;

    expect(approvalRevisionOwner(stored)).toBe("requester");
    expect(approvalDecisionNote(stored)).toContain("When the user continues");
    expect(approvalRevisionOwner({ ...stored, requestedBy: "owner" })).toBe("reviewer");
    expect(approvalRevisionOwner({ ...stored, requestedBy: "reviewer" })).toBe("requester");
    expect(
      approvalRevisionOwner({ ...stored, status: "rejected", requestedBy: "owner" })
    ).toBeUndefined();
    expect(
      approvalDecisionNote({ ...stored, status: "rejected", requestedBy: "owner" })
    ).not.toMatch(/revised proposal/u);
  });

  it("keeps the event when the post-commit hook fails and rejects a second decision", async () => {
    const f = await fixture();
    const workflow = new ApprovalRequestWorkflow({
      clientInstanceId,
      store: f.store.approvals,
      handlers: new Map([[f.handler.kind, f.handler]]),
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: f.store.audit }),
      onDecided: () => {
        throw new Error("Hook failed");
      }
    });
    const request = await f.create();
    await expect(
      workflow.decideRequest(reviewer, context, { requestId: request.id, decision: "reject" })
    ).rejects.toThrow("Hook failed");
    expect(await f.messages()).toHaveLength(1);
    await expect(
      f.workflow.decideRequest(reviewer, context, { requestId: request.id, decision: "approve" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.messages()).toHaveLength(1);
  });

  it("does not create history without an origin or resurrect deleted conversations", async () => {
    const f = await fixture();
    const request = await f.create();
    await f.store.conversations.deleteConversation({
      clientInstanceId,
      conversationId: f.conversation.id,
      deletedAt: new Date().toISOString()
    });
    await f.workflow.decideRequest(reviewer, context, {
      requestId: request.id,
      decision: "reject"
    });
    await expect(f.messages()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      createApprovalDecisionMessage({ ...request, origin: undefined, status: "approved" })
    ).toBeUndefined();
    expect(createApprovalDecisionMessage(request)).toBeUndefined();
  });

  it("keeps unknown metadata readable and excludes decisions after the run input boundary", async () => {
    const f = await fixture();
    const input = await f.store.conversations.appendMessage({
      clientInstanceId,
      conversationId: f.conversation.id,
      role: "user",
      text: "Continue"
    });
    const request = await f.create();
    await f.workflow.decideRequest(reviewer, context, {
      requestId: request.id,
      decision: "reject"
    });
    const stored = await f.messages();
    expect(dropCurrentSubmittedMessage(stored, input.text, input.id)).toEqual([]);
    const unknown = {
      ...input,
      metadata: { agentRuntime: { version: 1, kind: "future_event", detail: "safe" } }
    };
    expect(messageSchema.parse(unknown).metadata).toEqual(unknown.metadata);
    expect(readAgentRuntimeMessageMetadata(unknown.metadata)).toBeUndefined();
    await expect(
      projectAgentVisibleHistory([unknown], { toolOutput: { maxTokens: 1000 } })
    ).resolves.toEqual([{ role: "user", content: input.text }]);
  });

  it("keeps every newly delivered decision even when their batch exceeds the history window", async () => {
    const f = await fixture();
    for (let index = 0; index < 4; index += 1) {
      const request = await f.create();
      await f.workflow.decideRequest(reviewer, context, {
        requestId: request.id,
        decision: "reject"
      });
    }
    expect(selectRecentCompleteHistory(await f.messages(), 2)).toHaveLength(4);
  });

  it.each(["none", "stored", "legacy"] as const)(
    "delivers a decision during tool execution on the next run with %s continuation",
    async (continuationMode) => {
      const f = await fixture();
      const request = await f.create();
      const compact = continuationMode !== "none";
      const providerConfig: ModelProviderConfig = {
        id: "test-provider",
        type: "openai-compatible",
        api: "responses",
        model: "test-model",
        baseUrl: "https://example.test/v1",
        apiKeyEnvName: "UNUSED_TEST_API_KEY",
        ...(compact ? { contextManagement: { compaction: { compactThresholdTokens: 1000 } } } : {})
      };
      const continuation = {
        providerId: providerConfig.id,
        state: { compactionItem: { type: "compaction", encrypted_content: "opaque" } }
      };
      const calls: Parameters<ModelProvider["complete"]>[0][] = [];
      const modelProvider: ModelProvider = {
        id: providerConfig.id,
        async complete(input) {
          calls.push(structuredClone(input));
          if (calls.length === 1) {
            return {
              text: "Checking",
              toolCalls: [{ toolCallId: "call", toolName: "check", input: {} }],
              usage
            };
          }
          return {
            text: "Done",
            toolCalls: [],
            usage,
            ...(compact ? { continuation, contextManagement: { compacted: true } } : {})
          };
        }
      };
      const runtime = new LocalAgentRuntime({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              name: "agent",
              displayName: "Agent",
              instructions: "Help",
              modelProviderId: providerConfig.id,
              toolNames: [],
              skillNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: f.store.conversations,
        modelProviderContinuationStore: f.store,
        agentRunStore: f.store,
        runObservationStore: f.store,
        modelProvider,
        toolRegistry: new ToolRegistry({ tools: [] }),
        toolExecution: {
          authorize: async () => ({ status: "allowed" }),
          execute: async () => {
            expect((await f.messages()).at(-1)?.metadata?.agentRuntime).toMatchObject({
              kind: "assistant_tool_calls"
            });
            await f.workflow.decideRequest(reviewer, context, {
              requestId: request.id,
              decision: "request_changes",
              comment: "Include the appendix"
            });
            return { status: "success", output: { checked: true } };
          }
        },
        usageGovernance: new ModelUsageGovernance({
          store: f.store.usage,
          budget: {},
          safeguards: {}
        })
      });
      const runTurn = async (text: string) => {
        const input = await f.store.conversations.appendMessage({
          clientInstanceId,
          conversationId: f.conversation.id,
          role: "user",
          text
        });
        const run = await runtime.start(
          {
            agentName: "agent",
            conversationId: f.conversation.id,
            inputMessageId: input.id,
            message: { text }
          },
          context
        );
        for await (const event of runtime.observe(run.runId, context)) {
          expect(event.type).not.toBe("run_failed");
        }
      };
      await runTurn("Check");
      expect(calls).toHaveLength(2);
      expect(JSON.stringify(calls)).not.toContain("approval_decision");
      expect(JSON.stringify(calls)).not.toContain("Include the appendix");
      const stored = await f.messages();
      expect(stored.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "system",
        "tool",
        "assistant"
      ]);
      const checkpoint = await f.store.conversations.getModelProviderContinuation({
        clientInstanceId,
        conversationId: f.conversation.id,
        providerId: providerConfig.id
      });
      if (compact) {
        expect(checkpoint?.state).toEqual(continuation.state);
        expect(checkpoint?.sourceMessageId).toBe(stored.at(-1)?.id);
      } else {
        expect(checkpoint).toBeUndefined();
      }
      if (continuationMode === "legacy") {
        const final = stored.at(-1);
        if (
          !final?.metadata?.agentRuntime ||
          typeof final.metadata.agentRuntime !== "object" ||
          Array.isArray(final.metadata.agentRuntime)
        ) {
          throw new Error("Expected final metadata");
        }
        final.metadata.agentRuntime.providerContinuation = continuation;
        // Exercise the legacy metadata checkpoint independently of the dedicated store.
        f.store.conversations.getModelProviderContinuation = async () => undefined;
      }
      const replay = await projectAgentVisibleHistory(stored, { toolOutput: { maxTokens: 1000 } });
      expect(replay.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
        "system"
      ]);
      expect(replay[1]).toMatchObject({ toolCalls: [{ toolCallId: "call" }] });
      expect(replay[2]).toMatchObject({ toolCallId: "call" });
      await runTurn("Revise it");
      expect(calls).toHaveLength(3);
      const following = calls[2];
      expect(following?.continuation).toEqual(compact ? continuation : undefined);
      const notes = following?.messages.filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes(`Approval request ${request.id}`)
      );
      expect(notes).toHaveLength(1);
      expect(notes?.[0]?.content).toContain("The reviewer has taken over the revision");
      expect(notes?.[0]?.content).toContain("Include the appendix");
      expect(JSON.stringify(following)).not.toContain("PRIVATE_");
      expect(following?.messages.at(-1)).toMatchObject({ role: "user", content: "Revise it" });
      if (compact) {
        expect(following?.messages.map((message) => message.role)).toEqual([
          "system",
          "assistant",
          "system",
          "user"
        ]);
        if (continuationMode === "stored") {
          await runTurn("Continue after consuming the note");
          expect(JSON.stringify(calls[3]?.messages)).not.toContain(
            `Approval request ${request.id}`
          );
          expect(calls[3]?.continuation).toEqual(continuation);
        }
      }
    }
  );
});
