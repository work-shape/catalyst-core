import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type {
  ApiClient,
  LocaleCode,
  RunObservation,
  StartConversationRunResponse
} from "@vivd-catalyst/api-client";
import { firstLineTitle } from "../conversation-title";

export interface ProductRunTransportOptions {
  client: Pick<ApiClient, "createConversationRun" | "observeRunEvents" | "startConversationRun">;
  selectedConversationId?: string;
  locale: LocaleCode;
  selectedAgentName?: string;
  isSendDisabled?: () => string | undefined;
  createIdempotencyKey?: () => string;
  onMessageSubmitted?: (conversationId: string) => void;
  onRunStarted?: (response: StartConversationRunResponse) => void;
}

export class ProductConversationRunTransport implements ChatTransport<UIMessage> {
  private readonly idempotencyKeysByMessageId = new Map<string, string>();

  constructor(private readonly options: ProductRunTransportOptions) {}

  async sendMessages({
    abortSignal,
    messageId,
    messages,
    trigger
  }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]): Promise<ReadableStream<UIMessageChunk>> {
    if (trigger !== "submit-message") {
      throw new Error("Only new message submission is supported by the product run transport.");
    }

    const blockedReason = this.options.isSendDisabled?.();
    if (blockedReason) {
      throw new Error(blockedReason);
    }

    const submittedUserMessage = findLastUserMessage(messages);
    const text = extractUserText(submittedUserMessage);
    if (!text) {
      throw new Error("A user text message is required.");
    }

    const idempotencyKey = this.getIdempotencyKey(messageId ?? submittedUserMessage?.id);
    const response = await startProductConversationRun({
      agentName: this.options.selectedAgentName,
      client: this.options.client,
      conversationId: this.options.selectedConversationId,
      idempotencyKey,
      locale: this.options.locale,
      text
    });

    this.options.onMessageSubmitted?.(response.conversation.id);
    this.options.onRunStarted?.(response);

    return createRunUiMessageChunkStream({
      client: this.options.client,
      conversationId: response.conversation.id,
      runId: response.run.id,
      afterSequence: response.thread.activeRun?.projection.lastSequence ?? response.run.lastSequence,
      signal: abortSignal
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }

  private getIdempotencyKey(messageId: string | undefined): string {
    if (!messageId) {
      return createRunIdempotencyKey();
    }
    const existing = this.idempotencyKeysByMessageId.get(messageId);
    if (existing) {
      return existing;
    }
    const next = this.options.createIdempotencyKey?.() ?? createRunIdempotencyKey();
    this.idempotencyKeysByMessageId.set(messageId, next);
    return next;
  }
}

export async function startProductConversationRun({
  agentName,
  client,
  conversationId,
  idempotencyKey,
  locale,
  text
}: {
  agentName?: string;
  client: Pick<ApiClient, "createConversationRun" | "startConversationRun">;
  conversationId?: string;
  idempotencyKey: string;
  locale: LocaleCode;
  text: string;
}): Promise<StartConversationRunResponse> {
  const request = {
    idempotencyKey,
    ...(agentName ? { agentName } : {}),
    locale,
    message: {
      text
    }
  };

  if (conversationId) {
    return client.startConversationRun(conversationId, request);
  }

  return client.createConversationRun({
    ...request,
    conversation: {
      title: firstLineTitle(text),
      locale
    }
  });
}

export function createRunIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return `run-start:${cryptoApi.randomUUID()}`;
  }
  return `run-start:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export function createRunUiMessageChunkStream({
  afterSequence,
  client,
  conversationId,
  runId,
  signal
}: {
  afterSequence: number;
  client: Pick<ApiClient, "observeRunEvents">;
  conversationId: string;
  runId: string;
  signal?: AbortSignal;
}): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      let textPartId: string | undefined;
      let textPartIndex = 0;
      let streamErrored = false;
      const activeReasoningPartIds = new Set<string>();

      function enqueue(chunk: UIMessageChunk): void {
        controller.enqueue(chunk);
      }

      function ensureTextPart(): string {
        if (!textPartId) {
          textPartId = `${runId}:text:${textPartIndex}`;
          textPartIndex += 1;
          enqueue({
            type: "text-start",
            id: textPartId
          });
        }
        return textPartId;
      }

      function closeTextPart(): void {
        if (!textPartId) {
          return;
        }
        enqueue({
          type: "text-end",
          id: textPartId
        });
        textPartId = undefined;
      }

      function ensureReasoningPart(id: string): void {
        if (activeReasoningPartIds.has(id)) {
          return;
        }
        activeReasoningPartIds.add(id);
        enqueue({
          type: "reasoning-start",
          id
        });
      }

      function closeReasoningParts(): void {
        for (const id of activeReasoningPartIds) {
          enqueue({
            type: "reasoning-end",
            id
          });
        }
        activeReasoningPartIds.clear();
      }

      enqueue({
        type: "start",
        messageId: runId,
        messageMetadata: {
          conversationId,
          runId
        }
      });
      enqueue({
        type: "start-step"
      });

      try {
        for await (const observation of client.observeRunEvents(conversationId, runId, {
          afterSequence,
          signal
        })) {
          const event = observation.payload;

          if (event.type === "reasoning_delta") {
            closeTextPart();
            ensureReasoningPart(event.id);
            enqueue({
              type: "reasoning-delta",
              id: event.id,
              delta: event.delta
            });
          }

          if (event.type === "message_delta") {
            closeReasoningParts();
            const activeTextPartId = ensureTextPart();
            enqueue({
              type: "text-delta",
              id: activeTextPartId,
              delta: event.delta
            });
          }

          if (event.type === "tool_call_started") {
            closeTextPart();
            closeReasoningParts();
            enqueue({
              type: "tool-input-available",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
              dynamic: true,
              title: event.toolName
            });
          }

          if (event.type === "tool_permission_requested") {
            closeTextPart();
            closeReasoningParts();
            enqueue({
              type: "tool-approval-request",
              approvalId: `${event.toolCallId}:approval`,
              toolCallId: event.toolCallId
            });
          }

          if (event.type === "tool_call_completed") {
            closeTextPart();
            closeReasoningParts();
            enqueue({
              type: "tool-output-available",
              toolCallId: event.toolCallId,
              output: toToolUiOutput(event),
              dynamic: true
            });
          }

          if (event.type === "tool_call_failed") {
            closeTextPart();
            closeReasoningParts();
            enqueue({
              type: "tool-output-error",
              toolCallId: event.toolCallId,
              errorText: toToolUiError(event),
              dynamic: true
            });
          }

          if (event.type === "message_completed") {
            enqueue({
              type: "message-metadata",
              messageMetadata: {
                conversationId,
                runId,
                persistedMessageId: event.message.id,
                createdAt: event.createdAt
              }
            });
          }

          if (event.type === "run_failed") {
            closeTextPart();
            closeReasoningParts();
            enqueue({
              type: "error",
              errorText: event.error.message
            });
            return;
          }

          if (event.type === "run_cancelled") {
            closeTextPart();
            closeReasoningParts();
          }

          if (event.type === "run_completed") {
            break;
          }
        }

        closeTextPart();
        closeReasoningParts();
        enqueue({
          type: "finish-step"
        });
        enqueue({
          type: "finish",
          finishReason: "stop",
          messageMetadata: {
            conversationId,
            runId
          }
        });
      } catch (error) {
        if (isAbortLikeError(error)) {
          return;
        }
        streamErrored = true;
        controller.error(error);
        return;
      } finally {
        if (!streamErrored) {
          controller.close();
        }
      }
    }
  });
}

function findLastUserMessage(messages: UIMessage[]): UIMessage | undefined {
  return messages.findLast((message) => message.role === "user");
}

function extractUserText(message: UIMessage | undefined): string {
  return (
    message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim() ?? ""
  );
}

function toToolUiOutput(
  event: Extract<RunObservation["payload"], { type: "tool_call_completed" }>
): Record<string, unknown> {
  const result = isRecord(event.result) ? event.result : undefined;
  if (result?.status === "success") {
    return {
      status: "success",
      output: result.output,
      display: result.display,
      artifacts: result.artifacts,
      projectionNotice: event.projectionNotice
    };
  }

  return {
    status: "failed",
    error: result?.error,
    projectionNotice: event.projectionNotice
  };
}

function toToolUiError(event: Extract<RunObservation["payload"], { type: "tool_call_failed" }>): string {
  const result = isRecord(event.result) ? event.result : undefined;
  const error = isRecord(result?.error) ? result.error : undefined;
  if (result?.status === "failed" && typeof error?.message === "string") {
    return error.message;
  }
  return "Tool call failed";
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/u.test(error.message.toLowerCase()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
