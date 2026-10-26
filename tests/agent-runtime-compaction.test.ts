import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  asClientInstanceId,
  readAssistantModelContextSnapshot,
  readAssistantProviderContinuation,
  type JsonObject,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import {
  modelContentText,
  OPENAI_RESPONSES_STRING_MAX_CHARS,
  OpenAiCompatibleChatProvider
} from "@work-shape/catalyst-model-provider";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { describe, expect, it, vi } from "vitest";
import {
  createConversationWithMessages,
  createUnusedToolRunner,
  noReportedUsage
} from "./helpers/agent-runtime";
import {
  withoutStreaming,
  withTestModelGateway,
  type FakeModelProvider
} from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

describe("local agent runtime", () => {
  it("resumes from the latest durable provider compaction checkpoint", async () => {
    const clientInstanceId = asClientInstanceId("provider-compaction-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-provider-compaction",
      user: {
        id: "user-1",
        externalUserId: "user-1",
        displayLabel: "User",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "test"
      }
    };
    const store = (await createTestInstance()).stores;
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: [
        { role: "user", text: "Old question" },
        { role: "assistant", text: "Old answer" }
      ]
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "openai-compatible",
      api: "responses",
      model: "test-model",
      contextManagement: {
        compaction: {
          compactThresholdTokens: 270000
        }
      }
    };
    const continuation = {
      providerId: "test-provider",
      state: {
        compaction: {
          type: "compaction",
          encrypted_content: "opaque-compaction-state"
        }
      }
    };
    const requests: Parameters<FakeModelProvider["complete"]>[0][] = [];
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            text: "After compaction.",
            toolCalls: [],
            continuation,
            contextManagement: { compacted: true },
            usage: {
              ...noReportedUsage(),
              inputTokens: 269000,
              totalTokens: 269100
            }
          };
        }
        return {
          text: "Continued from checkpoint.",
          toolCalls: [],
          contextManagement: { compacted: false },
          usage: {
            ...noReportedUsage(),
            inputTokens: 1200,
            totalTokens: 1250
          }
        };
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "compaction_agent",
              displayName: "Compaction Agent",
              instructions: "Help the user.",
              modelProviderId: "test-provider",
              toolNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        modelProviderContinuationStore: store.conversations,
        agentRunStore: store.agentRuns,
        runObservationStore: store.agentRuns,
        modelProvider,
        toolRegistry: new ToolRegistry({ tools: [] }),
        runTool: createUnusedToolRunner(),
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );

    const firstUserMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId,
      role: "user",
      text: "Compact this conversation"
    });
    const firstRun = await runtime.start(
      {
        agentName: "compaction_agent",
        conversationId,
        inputMessageId: firstUserMessage.id,
        message: { text: firstUserMessage.text }
      },
      context
    );
    let emittedMetadata: JsonObject | undefined;
    for await (const event of runtime.observe(firstRun.runId, context)) {
      if (event.type === "message_completed") {
        emittedMetadata = event.message.metadata;
      }
    }

    expect(readAssistantProviderContinuation(emittedMetadata)).toBeUndefined();
    expect(readAssistantModelContextSnapshot(emittedMetadata)).toEqual({
      inputTokens: 269000,
      compactThresholdTokens: 270000,
      compacted: true
    });

    const persistedAfterCompaction = await store.conversations.listMessages({
      clientInstanceId,
      conversationId
    });
    const checkpoint = persistedAfterCompaction.at(-1);
    expect(readAssistantProviderContinuation(checkpoint?.metadata)).toBeUndefined();
    expect(
      await store.conversations.getModelProviderContinuation({
        clientInstanceId,
        conversationId,
        providerId: "test-provider"
      })
    ).toEqual({
      clientInstanceId,
      conversationId,
      providerId: "test-provider",
      state: continuation.state,
      sourceMessageId: checkpoint?.id,
      updatedAt: checkpoint?.createdAt
    });

    const secondUserMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId,
      role: "user",
      text: "Continue"
    });
    const secondRun = await runtime.start(
      {
        agentName: "compaction_agent",
        conversationId,
        inputMessageId: secondUserMessage.id,
        message: { text: secondUserMessage.text }
      },
      context
    );
    for await (const _event of runtime.observe(secondRun.runId, context)) {
      // Drain the second run.
    }

    expect(requests[1]?.continuation).toEqual(continuation);
    expect(
      requests[1]?.messages.map((message) => ({
        role: message.role,
        text: modelContentText(message.content)
      }))
    ).toEqual([
      { role: "system", text: expect.stringContaining("Help the user.") },
      { role: "assistant", text: "After compaction." },
      { role: "user", text: "Continue" }
    ]);

    const legacyContinuation = {
      providerId: "test-provider",
      state: { compaction: { encrypted_content: "newer-legacy-checkpoint" } }
    };
    await store.conversations.appendMessage({
      clientInstanceId,
      conversationId,
      role: "assistant",
      text: "Written by an older API process.",
      metadata: {
        agentRuntime: {
          version: 1,
          kind: "assistant_final",
          runId: "run_legacy",
          finishStatus: "completed",
          providerContinuation: legacyContinuation
        }
      }
    });
    const thirdUserMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId,
      role: "user",
      text: "Continue after the mixed-version write"
    });
    const thirdRun = await runtime.start(
      {
        agentName: "compaction_agent",
        conversationId,
        inputMessageId: thirdUserMessage.id,
        message: { text: thirdUserMessage.text }
      },
      context
    );
    for await (const _event of runtime.observe(thirdRun.runId, context)) {
      // Drain the third run.
    }

    expect(requests[2]?.continuation).toEqual(legacyContinuation);
    expect(
      requests[2]?.messages.map((message) => ({
        role: message.role,
        text: modelContentText(message.content)
      }))
    ).toEqual([
      { role: "system", text: expect.stringContaining("Help the user.") },
      { role: "assistant", text: "Written by an older API process." },
      { role: "user", text: "Continue after the mixed-version write" }
    ]);
  });

  it("sends a conversation from its history when its stored compaction item is above the provider's limit", async () => {
    const f = await storedContinuationFixture(
      "continuation-above-limit",
      "x".repeat(OPENAI_RESPONSES_STRING_MAX_CHARS + 1)
    );
    try {
      f.answers.push(responsesAnswer("Answered from history."));

      expect(await f.runToEnd("Third question")).toEqual([
        "message_delta",
        "message_completed",
        "run_completed"
      ]);
      expect(f.requestBodies).toHaveLength(1);
      expect(f.requestBodies[0]).not.toContain('"encrypted_content"');
      expect(f.requestBodies[0]).toContain("First question");
      expect(f.requestBodies[0]).toContain("Third question");
      expect(await f.storedContinuation()).toBeUndefined();
    } finally {
      f.restore();
    }
  });

  it("drops a continuation the provider refuses as too long and retries once from history", async () => {
    const f = await storedContinuationFixture("continuation-refused", "opaque-checkpoint");
    try {
      f.answers.push(
        // Any input item's ciphertext counts: here a reasoning item beside the checkpoint.
        providerRefusal("string_above_max_length", "input[4].encrypted_content"),
        responsesAnswer("Answered after the rebuild.")
      );

      expect(await f.runToEnd("Third question")).toEqual([
        "message_delta",
        "message_completed",
        "run_completed"
      ]);
      expect(f.requestBodies).toHaveLength(2);
      expect(f.requestBodies[0]).toContain('"encrypted_content"');
      expect(f.requestBodies[0]).not.toContain("First question");
      expect(f.requestBodies[1]).not.toContain('"encrypted_content"');
      expect(f.requestBodies[1]).toContain("First question");
      expect(f.requestBodies[1]).toContain("Third question");
      expect(await f.storedContinuation()).toBeUndefined();

      // The conversation stays alive: the next message goes out from history at once.
      f.answers.push(responsesAnswer("Still answering."));
      expect((await f.runToEnd("Fourth question")).at(-1)).toBe("run_completed");
      expect(f.requestBodies).toHaveLength(3);
    } finally {
      f.restore();
    }
  });

  it("keeps the continuation and does not retry on any other refusal", async () => {
    const f = await storedContinuationFixture("continuation-kept", "opaque-checkpoint");
    try {
      for (const [code, param] of [
        ["invalid_value", "input[1].encrypted_content"],
        ["string_above_max_length", "input[2].content"]
      ] as const) {
        f.requestBodies.length = 0;
        f.answers.push(providerRefusal(code, param));

        expect(await f.runToEnd("Third question")).toEqual(["run_failed"]);
        expect(f.requestBodies).toHaveLength(1);
        expect(await f.storedContinuation()).toBeDefined();
      }
    } finally {
      f.restore();
    }
  });

  it("fails with a message about the conversation's length when the rebuilt history is too long", async () => {
    const f = await storedContinuationFixture("continuation-history-too-long", "opaque-checkpoint");
    try {
      f.answers.push(
        providerRefusal("string_above_max_length", "input[1].encrypted_content"),
        providerRefusal("context_length_exceeded", "input")
      );

      const events = await f.runEventsToEnd("Third question");

      expect(f.requestBodies).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({
        type: "run_failed",
        error: {
          code: "VALIDATION_FAILED",
          message: "This conversation is too long for the model. Start a new conversation.",
          category: "app_error"
        }
      });
    } finally {
      f.restore();
    }
  });
});

function responsesAnswer(text: string): Response {
  return Response.json({
    output: [{ type: "message", content: [{ type: "output_text", text }] }]
  });
}

function providerRefusal(code: string, param: string): Response {
  return Response.json(
    { error: { message: "Refused.", type: "invalid_request_error", code, param } },
    { status: 400 }
  );
}

/**
 * A compacting Responses provider behind the runtime, and a conversation of two exchanges whose
 * first answer is the stored compaction checkpoint. Answers are served in the order pushed.
 */
async function storedContinuationFixture(name: string, encryptedContent: string) {
  const clientInstanceId = asClientInstanceId(`${name}-client`);
  const context: RuntimeCallContext = {
    clientInstanceId,
    correlationId: `corr-${name}`,
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
  const store = (await createTestInstance()).stores;
  const compaction = { compaction: { compactThresholdTokens: 270_000 } };
  const providerConfig: ModelProviderConfig = {
    id: "test-provider",
    type: "openai-compatible",
    api: "responses",
    model: "test-model",
    contextManagement: compaction
  };
  const provider = new OpenAiCompatibleChatProvider({
    id: providerConfig.id,
    api: "responses",
    model: providerConfig.model,
    baseUrl: "https://provider.test/v1",
    apiKey: "test",
    contextManagement: compaction
  });
  const conversationId = await createConversationWithMessages(store, {
    clientInstanceId,
    messages: [{ role: "user", text: "First question" }]
  });
  await store.conversations.appendAssistantMessage({
    clientInstanceId,
    conversationId,
    text: "First answer",
    providerContinuation: {
      providerId: providerConfig.id,
      state: {
        kind: "openai_responses",
        compactionItem: { id: "cmp_1", type: "compaction", encrypted_content: encryptedContent },
        encryptedReasoningItems: []
      }
    }
  });
  await store.conversations.appendMessage({
    clientInstanceId,
    conversationId,
    role: "user",
    text: "Second question"
  });
  await store.conversations.appendAssistantMessage({
    clientInstanceId,
    conversationId,
    text: "Second answer"
  });
  const answers: Response[] = [];
  const requestBodies: string[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    requestBodies.push(String(init?.body));
    const answer = answers.shift();
    if (!answer) {
      throw new Error("The provider was asked more often than the test expects");
    }
    return answer;
  });
  const runtime = new LocalAgentRuntime(
    withTestModelGateway({
      assetSource: createStaticConfigAssetSource({
        agents: [
          {
            skillNames: [],
            name: "stored_continuation_agent",
            displayName: "Stored Continuation Agent",
            instructions: "Help the user.",
            modelProviderId: providerConfig.id,
            toolNames: [],
            initialPrompts: []
          }
        ]
      }),
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store.conversations,
      modelProviderContinuationStore: store.conversations,
      modelProvider: withoutStreaming(provider),
      toolRegistry: new ToolRegistry({ tools: [] }),
      runTool: createUnusedToolRunner(),
      usageGovernance: new ModelUsageGovernance({ store: store.usage, budget: {}, safeguards: {} })
    })
  );
  async function runEventsToEnd(text: string) {
    const userMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId,
      role: "user",
      text
    });
    const run = await runtime.start(
      {
        agentName: "stored_continuation_agent",
        conversationId,
        inputMessageId: userMessage.id,
        message: { text }
      },
      context
    );
    const events = [];
    for await (const event of runtime.observe(run.runId, context)) {
      events.push(event);
    }
    return events;
  }
  return {
    answers,
    requestBodies,
    runEventsToEnd,
    async runToEnd(text: string): Promise<string[]> {
      return (await runEventsToEnd(text)).map((event) => event.type);
    },
    storedContinuation: () =>
      store.conversations.getModelProviderContinuation({
        clientInstanceId,
        conversationId,
        providerId: providerConfig.id
      }),
    restore: () => fetchMock.mockRestore()
  };
}
