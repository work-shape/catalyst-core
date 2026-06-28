import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { ApiClient, LocaleCode, StartConversationRunResponse } from "@vivd-catalyst/api-client";
import { firstLineTitle } from "../conversation-title";

export interface ProductRunTransportOptions {
  client: Pick<ApiClient, "createConversationRun" | "startConversationRun">;
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

    return createAcceptedRunUiMessageChunkStream({
      conversationId: response.conversation.id,
      runId: response.run.id
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

function createAcceptedRunUiMessageChunkStream({
  conversationId: _conversationId,
  runId: _runId
}: {
  conversationId: string;
  runId: string;
}): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.close();
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
