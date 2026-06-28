import { describe, expect, it } from "vitest";
import type { StartConversationRunResponse } from "@vivd-catalyst/api-client";
import {
  ProductConversationRunTransport,
  startProductConversationRun
} from "../packages/chat-ui/src/assistant/product-run-transport";

type ProductUiMessage = Parameters<ProductConversationRunTransport["sendMessages"]>[0]["messages"][number];
type ProductUiMessageChunk =
  Awaited<ReturnType<ProductConversationRunTransport["sendMessages"]>> extends ReadableStream<infer Chunk>
    ? Chunk
    : never;

describe("chat UI product run transport", () => {
  it("starts a new conversation through the product createConversationRun API", async () => {
    const calls: unknown[] = [];
    const client = {
      async createConversationRun(input: unknown) {
        calls.push(input);
        return createStartResponse({ conversationId: "conv_new" });
      },
      async startConversationRun() {
        throw new Error("startConversationRun should not be called");
      }
    };

    const response = await startProductConversationRun({
      client,
      idempotencyKey: "idem-new",
      locale: "en",
      text: "Create this conversation",
      agentName: "agent_a"
    });

    expect(response.conversation.id).toBe("conv_new");
    expect(calls).toEqual([
      {
        idempotencyKey: "idem-new",
        agentName: "agent_a",
        locale: "en",
        message: {
          text: "Create this conversation"
        },
        conversation: {
          title: "Create this conversation",
          locale: "en"
        }
      }
    ]);
  });

  it("starts an existing conversation through the product startConversationRun API", async () => {
    const calls: unknown[] = [];
    const client = {
      async createConversationRun() {
        throw new Error("createConversationRun should not be called");
      },
      async startConversationRun(conversationId: string, input: unknown) {
        calls.push({ conversationId, input });
        return createStartResponse({ conversationId });
      }
    };

    await startProductConversationRun({
      client,
      conversationId: "conv_existing",
      idempotencyKey: "idem-existing",
      locale: "de",
      text: "Continue this conversation"
    });

    expect(calls).toEqual([
      {
        conversationId: "conv_existing",
        input: {
          idempotencyKey: "idem-existing",
          locale: "de",
          message: {
            text: "Continue this conversation"
          }
        }
      }
    ]);
  });

  it("reuses the generated idempotency key for the submitted user message", async () => {
    const idempotencyKeys: string[] = [];
    const client = {
      async createConversationRun(input: { idempotencyKey: string }) {
        idempotencyKeys.push(input.idempotencyKey);
        return createStartResponse({ conversationId: "conv_new" });
      },
      async startConversationRun() {
        throw new Error("startConversationRun should not be called");
      }
    };
    const transport = new ProductConversationRunTransport({
      client,
      locale: "en",
      createIdempotencyKey: () => `idem-${idempotencyKeys.length + 1}`
    });
    const message = createUserMessage("user_msg_1", "Please answer");

    await drainStream(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat",
        messageId: message.id,
        messages: [message],
        abortSignal: undefined
      })
    );
    await drainStream(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat",
        messageId: message.id,
        messages: [message],
        abortSignal: undefined
      })
    );

    expect(idempotencyKeys).toEqual(["idem-1", "idem-1"]);
  });

  it("hands started runs to the workspace observer without assistant-ui stream chunks", async () => {
    const submittedConversationIds: string[] = [];
    const startedRuns: StartConversationRunResponse[] = [];
    const response = createStartResponse({ conversationId: "conv_new", lastSequence: 2 });
    const client = {
      async createConversationRun() {
        return response;
      },
      async startConversationRun() {
        throw new Error("startConversationRun should not be called");
      }
    };
    const transport = new ProductConversationRunTransport({
      client,
      locale: "en",
      onMessageSubmitted(conversationId) {
        submittedConversationIds.push(conversationId);
      },
      onRunStarted(startedRun) {
        startedRuns.push(startedRun);
      }
    });
    const message = createUserMessage("user_msg_1", "Please answer");

    const chunks = await drainStream(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat",
        messageId: message.id,
        messages: [message],
        abortSignal: undefined
      })
    );

    expect(submittedConversationIds).toEqual(["conv_new"]);
    expect(startedRuns).toEqual([response]);
    expect(chunks).toEqual([]);
  });
});

async function drainStream(stream: ReadableStream<ProductUiMessageChunk>): Promise<ProductUiMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: ProductUiMessageChunk[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) {
      return chunks;
    }
    chunks.push(next.value);
  }
}

function createUserMessage(id: string, text: string): ProductUiMessage {
  return {
    id,
    role: "user",
    parts: [
      {
        type: "text",
        text
      }
    ]
  };
}

function createStartResponse({
  conversationId,
  lastSequence = 0
}: {
  conversationId: string;
  lastSequence?: number;
}): StartConversationRunResponse {
  return {
    conversation: {
      id: conversationId,
      clientInstanceId: "client_1",
      ownerUserId: "user_1",
      ownerExternalUserId: "external_1",
      title: "Test",
      status: "active",
      createdAt: "2026-06-26T10:00:00.000Z",
      updatedAt: "2026-06-26T10:00:00.000Z",
      retainedUntil: "2026-07-26T10:00:00.000Z"
    },
    userMessage: {
      id: "msg_user",
      conversationId,
      clientInstanceId: "client_1",
      role: "user",
      text: "Please answer",
      createdAt: "2026-06-26T10:00:01.000Z"
    },
    run: {
      id: "run_1",
      clientInstanceId: "client_1",
      conversationId,
      ownerUserId: "user_1",
      inputMessageId: "msg_user",
      agentName: "agent_a",
      status: "running",
      startedAt: "2026-06-26T10:00:01.000Z",
      updatedAt: "2026-06-26T10:00:01.000Z",
      lastSequence,
      correlationId: "corr_1"
    },
    thread: {
      conversation: {
        id: conversationId,
        clientInstanceId: "client_1",
        ownerUserId: "user_1",
        ownerExternalUserId: "external_1",
        title: "Test",
        status: "active",
        createdAt: "2026-06-26T10:00:00.000Z",
        updatedAt: "2026-06-26T10:00:00.000Z",
        retainedUntil: "2026-07-26T10:00:00.000Z"
      },
      messages: [],
      activeRun: {
        run: {
          id: "run_1",
          conversationId,
          agentName: "agent_a",
          status: "running",
          startedAt: "2026-06-26T10:00:01.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastSequence
        },
        projection: {
          runId: "run_1",
          lastSequence,
          status: "running",
          parts: [],
          text: "",
          reasoning: [],
          activeToolCalls: []
        }
      },
      userState: {
        clientInstanceId: "client_1",
        conversationId,
        userId: "user_1",
        updatedAt: "2026-06-26T10:00:01.000Z"
      },
      serverTime: "2026-06-26T10:00:01.000Z"
    },
    eventsUrl: `https://example.test/api/conversations/${conversationId}/runs/run_1/events`
  };
}
