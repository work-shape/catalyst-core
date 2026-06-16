import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  type ChatMessage,
  type ModelProviderConfig,
  type RuntimeCallContext,
  type ToolExecution
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { LocalAgentRuntime } from "@vivd-catalyst/agent-runtime";
import { modelContentText, type ModelMessage, type ModelProvider } from "@vivd-catalyst/model-provider";
import { ToolRegistry } from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

describe("local agent runtime", () => {
  it("loads recent conversation history before the new user message", async () => {
    const clientInstanceId = asClientInstanceId("history-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-history",
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
    const store = new InMemoryPlatformStore();
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: [
        { role: "user", text: "My favorite color is blue." },
        { role: "assistant", text: "I will remember that." },
        { role: "user", text: "What is my favorite color?" }
      ]
    });
    let providerMessages: ModelMessage[] = [];
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const modelProvider: ModelProvider = {
      id: "test-provider",
      async complete(request) {
        providerMessages = request.messages;
        const sawEarlierTurn = request.messages.some(
          (message) => message.role === "user" && modelContentText(message.content).includes("favorite color is blue")
        );
        return {
          text: sawEarlierTurn ? "Your favorite color is blue." : "I do not know yet.",
          toolCalls: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            source: "not_reported"
          }
        };
      }
    };
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "history_agent",
          displayName: "History Agent",
          instructions: "Use conversation history.",
          modelProviderId: "test-provider",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      modelProvider,
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

    const run = await runtime.start(
      {
        agentName: "history_agent",
        conversationId,
        message: {
          text: "What is my favorite color?"
        }
      },
      context
    );

    const completedMessages: string[] = [];
    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "message_completed") {
        completedMessages.push(event.message.text);
      }
    }

    expect(completedMessages).toEqual(["Your favorite color is blue."]);
    expect(providerMessages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user"
    ]);
  });

  it("adds the resolved locale to system instructions", async () => {
    const clientInstanceId = asClientInstanceId("locale-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-locale",
      locale: "de",
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
    const store = new InMemoryPlatformStore();
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    let providerMessages: ModelMessage[] = [];
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const modelProvider: ModelProvider = {
      id: "test-provider",
      async complete(request) {
        providerMessages = request.messages;
        return {
          text: "Erledigt.",
          toolCalls: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            source: "not_reported"
          }
        };
      }
    };
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "locale_agent",
          displayName: "Locale Agent",
          instructions: "Help the user.",
          modelProviderId: "test-provider",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      modelProvider,
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

    const run = await runtime.start(
      {
        agentName: "locale_agent",
        conversationId,
        message: {
          text: "Hallo"
        }
      },
      context
    );

    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "run_completed") {
        break;
      }
    }

    expect(providerMessages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Respond in German")
    });
  });
});

async function createConversationWithMessages(
  store: InMemoryPlatformStore,
  input: {
    clientInstanceId: ChatMessage["clientInstanceId"];
    messages: Array<{ role: ChatMessage["role"]; text: string }>;
  }
): Promise<ChatMessage["conversationId"]> {
  const conversation = await store.createConversation({
    clientInstanceId: input.clientInstanceId,
    ownerUserId: "user-1",
    ownerExternalUserId: "user-1",
    title: "Test conversation",
    retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
  });
  for (const message of input.messages) {
    await store.appendMessage({
      clientInstanceId: input.clientInstanceId,
      conversationId: conversation.id,
      role: message.role,
      text: message.text
    });
  }
  return conversation.id;
}

function createUnusedToolExecution(): ToolExecution {
  return {
    async authorize() {
      throw new Error("Tool execution should not be used");
    },
    async execute() {
      throw new Error("Tool execution should not be used");
    }
  };
}
