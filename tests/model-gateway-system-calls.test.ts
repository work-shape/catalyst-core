import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalCheckRunner,
  createChatServerJobs,
  generateConversationTitleJob
} from "@vivd-catalyst/chat-server";
import { createJobWorker } from "@vivd-catalyst/client-assembly";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type ApprovalCheckConfig,
  type ApprovalRequest,
  type ApprovalRequestHandler,
  type AuthenticatedUser,
  type ModelUsageEvent,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import type { ModelCompletion } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { settleOnFakeClock, useFakeClockBesidePostgres } from "./support/fake-clock";
import { createFailingTestLogger, createTestConfig } from "./support/fixtures";
import {
  createScriptedInstanceModelGateway,
  silentTestLogger,
  type ScriptedModelProvider
} from "./support/model-gateway";
import { createRetentionOptions } from "./support/retention-harness";
import { createTestInstance } from "./support/test-instance";

const clientInstanceId = asClientInstanceId("system-calls-test");
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => vi.useRealTimers());

function answer(text: string): ModelCompletion {
  return {
    text,
    toolCalls: [],
    usage: {
      inputTokens: 40,
      outputTokens: 2,
      totalTokens: 42,
      source: "provider_reported",
      webSearchCallCount: 0
    }
  };
}

/** A usage event of a call the product made for itself: it names no run. */
function expectSystemEvent(
  event: ModelUsageEvent | undefined,
  expected: Partial<ModelUsageEvent>
): void {
  expect(event).toMatchObject(expected);
  expect(event).not.toHaveProperty("agentRunId");
}

describe("a conversation title through the gateway", () => {
  it("leaves one usage event with the purpose, the conversation and no run", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "external-user-1",
      title: "please summarize the release notes",
      retainedUntil: new Date(Date.now() + 30 * DAY_MS).toISOString()
    });
    await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "please summarize the release notes"
    });
    const worker = createJobWorker({
      stores: store,
      clientInstanceId,
      logger: createFailingTestLogger("The title job failed"),
      ...createChatServerJobs(
        createRetentionOptions({
          clientInstanceId,
          store,
          modelProvider: { complete: async () => answer("Release Notes Summary") }
        })
      )
    });
    await store.jobs.enqueue(
      generateConversationTitleJob,
      { conversationId: conversation.id, userId: "user-1" },
      { clientInstanceId, dedupeKey: conversation.id }
    );

    await worker.runDue();
    await worker.stop();

    await expect(
      store.conversations.getConversation(clientInstanceId, conversation.id)
    ).resolves.toMatchObject({ title: "Release Notes Summary" });
    const events = await store.usage.listModelUsageEvents({ clientInstanceId });
    expect(events).toHaveLength(1);
    expectSystemEvent(events[0], {
      agentName: "conversation_title",
      conversationId: conversation.id,
      providerId: "local",
      totalTokens: 42,
      source: "provider_reported"
    });
  });

  it("ends a title call at its deadline, records it once and frees its place", async () => {
    const store = (await createTestInstance()).stores;
    const converse = async (text: string) => {
      const conversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: "user-1",
        createdByExternalUserId: "external-user-1",
        title: text,
        retainedUntil: new Date(Date.now() + 30 * DAY_MS).toISOString()
      });
      await store.conversations.appendMessage({
        clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text
      });
      return conversation;
    };
    const unanswered = await converse("what is our refund policy");
    const answered = await converse("please summarize the release notes");
    const enqueueTitle = (conversationId: string) =>
      store.jobs.enqueue(
        generateConversationTitleJob,
        { conversationId, userId: "user-1" },
        { clientInstanceId, dedupeKey: conversationId }
      );

    let attempts = 0;
    let deadline: Date | undefined;
    let called: () => void = () => undefined;
    const reachedProvider = new Promise<void>((resolve) => {
      called = resolve;
    });
    const worker = createJobWorker({
      stores: store,
      clientInstanceId,
      logger: silentTestLogger,
      ...createChatServerJobs(
        createRetentionOptions({
          clientInstanceId,
          store,
          // The second call is admitted only when the first no longer holds its place.
          modelCallsPerDay: 2,
          modelProvider: {
            // The first call is never answered and ignores the stop; later ones are answered.
            complete(_request, context) {
              attempts += 1;
              if (attempts > 1) return Promise.resolve(answer("Release Notes Summary"));
              deadline = context.deadline;
              called();
              return new Promise<ModelCompletion>(() => {});
            }
          }
        })
      )
    });
    await enqueueTitle(unanswered.id);
    useFakeClockBesidePostgres();

    let ended = false;
    const pass = worker.runDue().finally(() => {
      ended = true;
    });
    await settleOnFakeClock(reachedProvider);
    if (!deadline) throw new Error("The title call carried no deadline");

    // One millisecond before the deadline the call is still open, however long the test waits.
    await vi.advanceTimersByTimeAsync(deadline.getTime() - Date.now() - 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Date.now()).toBe(deadline.getTime() - 1);
    expect(ended).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await settleOnFakeClock(pass);
    vi.useRealTimers();

    expect(attempts).toBe(1);
    const afterDeadline = await store.usage.listModelUsageEvents({ clientInstanceId });
    expect(afterDeadline).toHaveLength(1);
    expectSystemEvent(afterDeadline[0], {
      agentName: "conversation_title",
      conversationId: unanswered.id,
      totalTokens: 0,
      source: "estimated"
    });
    await expect(
      store.conversations.getConversation(clientInstanceId, unanswered.id)
    ).resolves.toMatchObject({ title: unanswered.title });

    await enqueueTitle(answered.id);
    await worker.runDue();
    await worker.stop();

    await expect(
      store.conversations.getConversation(clientInstanceId, answered.id)
    ).resolves.toMatchObject({ title: "Release Notes Summary" });
    expect(await store.usage.listModelUsageEvents({ clientInstanceId })).toHaveLength(2);
  });
});

describe("an approval check through the gateway", () => {
  const user: AuthenticatedUser = {
    id: "requester",
    externalUserId: "requester",
    displayLabel: "Requester",
    roles: ["user"],
    permissionRefs: [],
    clientInstanceId,
    authSource: "test"
  };
  const context: RuntimeCallContext = { user, clientInstanceId, correlationId: "judge-call" };
  const rule: ApprovalCheckConfig = {
    id: "no_personal_data",
    appliesTo: "fake",
    modelBindingId: "judge",
    instruction: "Refuse personal data.",
    onFail: "block"
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
  const origin: ApprovalRequest["origin"] = {
    conversationId: asConversationId("conv_judged"),
    agentRunId: asAgentRunId("run_judged"),
    toolCallId: asToolCallId("call_judged"),
    agentName: "assistant"
  };
  const proposal = { kind: "fake", summary: "A proposal", payload: { newText: "New text" } };

  async function judge(
    modelProvider: ScriptedModelProvider,
    safeguards: { modelCallsPerDay?: number } = {}
  ) {
    const config = createTestConfig({
      modelBindings: [
        { id: "judge", providerId: "local", model: "cheap-check", agentSelectable: false }
      ]
    });
    config.approvalChecks = [rule];
    const store = (await createTestInstance()).stores;
    const runner = new ApprovalCheckRunner({
      config,
      clientInstanceId,
      modelGateway: createScriptedInstanceModelGateway({
        config,
        modelProvider,
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards
        })
      })
    });
    return { runner, events: () => store.usage.listModelUsageEvents({ clientInstanceId }) };
  }

  it("leaves one usage event with the purpose and no run, though a run caused it", async () => {
    const f = await judge({
      complete: async () => answer('{"violates":false,"reason":"Nothing personal."}')
    });

    await expect(f.runner.run(handler, { ...proposal, origin }, context)).resolves.toEqual([
      { id: rule.id, status: "passed", message: "" }
    ]);

    const events = await f.events();
    expect(events).toHaveLength(1);
    expectSystemEvent(events[0], {
      agentName: "guardrail_judge",
      conversationId: origin.conversationId,
      model: "cheap-check",
      correlationId: "judge-call",
      totalTokens: 42
    });
  });

  it("leaves one usage event for a check without an origin", async () => {
    const f = await judge({
      complete: async () => answer('{"violates":false,"reason":"Nothing personal."}')
    });

    await f.runner.run(handler, { ...proposal, origin: undefined }, context);

    const events = await f.events();
    expect(events).toHaveLength(1);
    expectSystemEvent(events[0], { agentName: "guardrail_judge", totalTokens: 42 });
    expect(events[0]).not.toHaveProperty("conversationId");
  });

  it("blocks and names the limit when the instance's call limit refuses the check", async () => {
    let attempts = 0;
    const f = await judge(
      {
        complete: async () => {
          attempts += 1;
          return answer('{"violates":false,"reason":"Nothing personal."}');
        }
      },
      { modelCallsPerDay: 1 }
    );
    await f.runner.run(handler, { ...proposal, origin }, context);

    await expect(f.runner.run(handler, { ...proposal, origin }, context)).resolves.toEqual([
      {
        id: rule.id,
        status: "blocked",
        message: `Check '${rule.id}' could not run because the model usage limit of this instance is reached. Try again later.`
      }
    ]);

    // The refused check was not sent and records nothing.
    expect(attempts).toBe(1);
    expect(await f.events()).toHaveLength(1);
  });

  it("settles a check that ran out of time once, without tokens", async () => {
    let called: () => void = () => undefined;
    const reachedProvider = new Promise<void>((resolve) => {
      called = resolve;
    });
    let attempts = 0;
    const f = await judge({
      // A provider that never answers and ignores the stop.
      complete() {
        attempts += 1;
        called();
        return new Promise<ModelCompletion>(() => {});
      }
    });
    useFakeClockBesidePostgres();

    const result = f.runner.run(handler, { ...proposal, origin }, context);
    await settleOnFakeClock(reachedProvider);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await settleOnFakeClock(result)).toEqual([
      {
        id: rule.id,
        status: "blocked",
        message: `Check '${rule.id}' did not answer within 60 seconds. Try again later.`
      }
    ]);
    vi.useRealTimers();
    // The timed-out call is not sent again and leaves exactly one event.
    expect(attempts).toBe(1);
    const events = await f.events();
    expect(events).toHaveLength(1);
    expectSystemEvent(events[0], {
      agentName: "guardrail_judge",
      totalTokens: 0,
      source: "estimated"
    });
  });
});
