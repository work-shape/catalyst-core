import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  asConversationId,
  type ChatMessage,
  type ConversationHistoryReader,
  type ModelProviderConfig,
  type RuntimeCallContext,
  type ToolExecution
} from "@agent-chat-platform/core";
import { InMemoryPlatformStore } from "@agent-chat-platform/core/testing";
import { LocalAgentRuntime } from "@agent-chat-platform/agent-runtime";
import type { ModelMessage, ModelProvider } from "@agent-chat-platform/model-provider";
import { ToolRegistry } from "@agent-chat-platform/tool-execution";
import { ModelUsageGovernance } from "@agent-chat-platform/usage-governance";

describe("local agent runtime", () => {
  it("loads recent conversation history before the new user message", async () => {
    const clientInstanceId = asClientInstanceId("history-client");
    const conversationId = asConversationId("conv_history");
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
          (message) => message.role === "user" && message.content.includes("favorite color is blue")
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
      conversationHistory: createHistoryReader([
        createMessage("msg_1", conversationId, clientInstanceId, "user", "My favorite color is blue."),
        createMessage("msg_2", conversationId, clientInstanceId, "assistant", "I will remember that."),
        createMessage("msg_3", conversationId, clientInstanceId, "user", "What is my favorite color?")
      ]),
      modelProvider,
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store: new InMemoryPlatformStore(),
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
});

function createHistoryReader(messages: ChatMessage[]): ConversationHistoryReader {
  return {
    async listRecentMessages(input) {
      return messages.slice(-input.limit);
    }
  };
}

function createMessage(
  id: string,
  conversationId: ChatMessage["conversationId"],
  clientInstanceId: ChatMessage["clientInstanceId"],
  role: ChatMessage["role"],
  text: string
): ChatMessage {
  return {
    id: id as ChatMessage["id"],
    conversationId,
    clientInstanceId,
    role,
    text,
    createdAt: new Date().toISOString()
  };
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
