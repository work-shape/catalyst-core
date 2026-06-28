import { describe, expect, it } from "vitest";
import type { RunObservation, StartConversationRunResponse } from "@vivd-catalyst/api-client";
import {
  ProductConversationRunTransport,
  createRunUiMessageChunkStream,
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
      },
      async *observeRunEvents(): AsyncIterable<RunObservation> {
        yield createObservation({ sequence: 1, type: "run_completed" });
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

  it("converts product run observations into assistant-ui stream chunks from the snapshot cursor", async () => {
    const afterSequences: Array<number | undefined> = [];
    const client = {
      async *observeRunEvents(
        _conversationId: string,
        _runId: string,
        options: { afterSequence?: number } = {}
      ): AsyncIterable<RunObservation> {
        afterSequences.push(options.afterSequence);
        yield createObservation({
          sequence: 3,
          type: "message_delta",
          payload: { delta: "Hello" }
        });
        yield createObservation({
          sequence: 4,
          type: "message_completed",
          payload: {
            message: {
              id: "msg_assistant",
              role: "assistant",
              text: "Hello",
              metadata: {
                agentRuntime: {
                  version: 1,
                  kind: "assistant_final",
                  runId: "run_1"
                }
              }
            }
          }
        });
        yield createObservation({ sequence: 5, type: "run_completed" });
      }
    };

    const chunks = await drainStream(
      createRunUiMessageChunkStream({
        client,
        conversationId: "conv_1",
        runId: "run_1",
        afterSequence: 2
      })
    );

    expect(afterSequences).toEqual([2]);
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "start", messageId: "run_1" }),
        expect.objectContaining({ type: "text-delta", delta: "Hello" }),
        expect.objectContaining({
          type: "message-metadata",
          messageMetadata: expect.objectContaining({
            persistedMessageId: "msg_assistant"
          })
        }),
        expect.objectContaining({ type: "finish" })
      ])
    );
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

function createObservation<TType extends RunObservation["payload"]["type"]>({
  sequence,
  type,
  payload
}: {
  sequence: number;
  type: TType;
  payload?: Partial<Omit<Extract<RunObservation["payload"], { type: TType }>, "runId" | "sequence" | "createdAt" | "type">>;
}): RunObservation {
  const createdAt = `2026-06-26T10:00:0${sequence}.000Z`;
  return {
    clientInstanceId: "client_1",
    conversationId: "conv_1",
    ownerUserId: "user_1",
    runId: "run_1",
    sequence,
    type,
    payload: {
      ...payload,
      type,
      runId: "run_1",
      sequence,
      createdAt
    } as RunObservation["payload"],
    createdAt
  };
}
