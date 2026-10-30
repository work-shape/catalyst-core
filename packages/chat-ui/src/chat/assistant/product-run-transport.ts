import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type {
  ApiClient,
  ChatInputCheckView,
  ConversationFollowUp,
  FollowUpMode,
  LocaleCode,
  StartConversationRunResponse
} from "@work-shape/catalyst-api-client";
import { NEW_CONVERSATION_TITLE } from "../../shared/conversation-title";
import type { ReasoningEffort } from "../workspace/agent-model-selection";

/** The two operations that start an agent run. */
export interface RunStartingClient {
  conversations: { runs: Pick<ApiClient["conversations"]["runs"], "create" | "start"> };
}

export interface ProductRunTransportOptions {
  client: RunStartingClient;
  collaborationWorkspaceId?: string;
  selectedConversationId?: string;
  locale: LocaleCode;
  selectedAgentName?: string;
  selectedModelBindingId?: string;
  /** The effort the user picked for the selected model; unset runs with its default. */
  selectedReasoningEffort?: ReasoningEffort;
  isSendDisabled?: () => string | undefined;
  createIdempotencyKey?: () => string;
  onMessageSubmitted?: (conversationId: string) => void;
  onRunStarted?: (response: StartConversationRunResponse) => void;
  /** The conversation had a run going after all: the message waits in its queue. */
  onFollowUpQueued?: (followUp: ConversationFollowUp) => void;
  /** Whether the person sends this text despite the warnings of the guardrails on it (GR-4). */
  acceptsGuardrailWarnings?: (text: string) => boolean;
  /**
   * The send failed. True where the guardrails refused the message, which the composer then
   * shows. The send then ends without an error, which the thread would show on the last
   * answer: the caller puts the text back into the composer once it has finished.
   */
  onSendRefused?: (error: unknown, text: string) => boolean;
}

/** The answer to a message for a conversation whose run is still going. */
export interface QueuedConversationMessage {
  followUp: ConversationFollowUp;
  /** What the guardrails could not check of it, or warned about and the person accepted. */
  chatInput?: ChatInputCheckView;
}

export class ProductConversationRunTransport implements ChatTransport<UIMessage> {
  private readonly idempotencyKeysByMessageId = new Map<string, string>();

  constructor(private readonly options: ProductRunTransportOptions) {}

  async sendMessages({
    messageId,
    messages,
    trigger
  }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    if (trigger !== "submit-message") {
      throw new Error("Only new message submission is supported by the product run transport.");
    }

    const blockedReason = this.options.isSendDisabled?.();
    if (blockedReason) {
      throw new Error(blockedReason);
    }

    const submittedUserMessage = findLastUserMessage(messages);
    const text = extractUserText(submittedUserMessage);
    // A picture or file may go alone: the server sends the conversation's ready attachments
    // with the message.
    if (!text && !submittedUserMessage?.parts.some((part) => part.type === "file")) {
      throw new Error("A message needs text or an attachment.");
    }

    const idempotencyKey = this.getIdempotencyKey(messageId ?? submittedUserMessage?.id);
    const selection = {
      agentName: this.options.selectedAgentName,
      modelBindingId: this.options.selectedModelBindingId,
      reasoningEffort: this.options.selectedReasoningEffort,
      client: this.options.client,
      idempotencyKey,
      locale: this.options.locale,
      text,
      ...(this.options.acceptsGuardrailWarnings?.(text) ? { acceptGuardrailWarnings: true } : {})
    };
    const conversationId = this.options.selectedConversationId;
    let response: StartConversationRunResponse | QueuedConversationMessage;
    try {
      response = conversationId
        ? await sendProductConversationMessage({ ...selection, conversationId })
        : await startProductConversationRun({
            ...selection,
            collaborationWorkspaceId: this.options.collaborationWorkspaceId
          });
    } catch (error) {
      if (this.options.onSendRefused?.(error, text)) return emptyUiMessageChunkStream();
      throw error;
    }
    if ("followUp" in response) {
      // A run this page did not know of was going: the message waits behind it.
      this.options.onMessageSubmitted?.(response.followUp.conversationId);
      this.options.onFollowUpQueued?.(response.followUp);
      return emptyUiMessageChunkStream();
    }

    this.options.onMessageSubmitted?.(response.conversation.id);
    this.options.onRunStarted?.(response);

    return emptyUiMessageChunkStream();
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
  modelBindingId,
  reasoningEffort,
  client,
  collaborationWorkspaceId,
  conversationId,
  idempotencyKey,
  locale,
  text,
  visibility,
  projectId,
  acceptGuardrailWarnings
}: {
  agentName?: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffort;
  client: RunStartingClient;
  collaborationWorkspaceId?: string;
  conversationId?: string;
  idempotencyKey: string;
  locale: LocaleCode;
  text: string;
  /** A new conversation that starts private, where its workspace's members would read it. */
  visibility?: "private";
  /** A new conversation that starts in this project, with the project's audience (PRJ-1). */
  projectId?: string;
  /** The person sends the message despite the guardrails' warnings on it (GR-4). */
  acceptGuardrailWarnings?: boolean;
}): Promise<StartConversationRunResponse> {
  const request = runStartRequest({
    agentName,
    modelBindingId,
    reasoningEffort,
    idempotencyKey,
    locale,
    text,
    acceptGuardrailWarnings
  });

  if (conversationId) {
    const response = await client.conversations.runs.start({
      params: { conversationId },
      body: request
    });
    if ("followUp" in response) throw new Error("Unexpected queued message response");
    return response;
  }

  return client.conversations.runs.create({
    body: {
      ...request,
      conversation: {
        title: firstLineTitle(text),
        locale,
        ...(collaborationWorkspaceId ? { collaborationWorkspaceId } : {}),
        ...(visibility ? { visibility } : {}),
        ...(projectId ? { projectId } : {})
      }
    }
  });
}

/**
 * Sends a message in an open conversation. A conversation whose run is still going keeps the
 * message in its queue and answers with it; the message starts as the next turn.
 */
export async function sendProductConversationMessage({
  conversationId,
  client,
  followUp = "queue",
  ...selection
}: {
  conversationId: string;
  /** While a run goes: wait as the next turn, or steer the run where the server allows it. */
  followUp?: FollowUpMode;
  agentName?: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffort;
  client: RunStartingClient;
  idempotencyKey: string;
  locale: LocaleCode;
  text: string;
  acceptGuardrailWarnings?: boolean;
}): Promise<StartConversationRunResponse | QueuedConversationMessage> {
  return client.conversations.runs.start({
    params: { conversationId },
    body: { ...runStartRequest(selection), followUp }
  });
}

function runStartRequest({
  agentName,
  modelBindingId,
  reasoningEffort,
  idempotencyKey,
  locale,
  text,
  acceptGuardrailWarnings
}: {
  agentName?: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffort;
  idempotencyKey: string;
  locale: LocaleCode;
  text: string;
  acceptGuardrailWarnings?: boolean;
}) {
  return {
    idempotencyKey,
    ...(acceptGuardrailWarnings ? { acceptGuardrailWarnings: true as const } : {}),
    ...(agentName ? { agentName } : {}),
    ...(modelBindingId ? { modelBindingId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    locale,
    message: {
      text
    }
  };
}

export function createRunIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return `run-start:${cryptoApi.randomUUID()}`;
  }
  return `run-start:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

/** The run's events reach the page on its own stream, so the thread runtime gets none. */
function emptyUiMessageChunkStream(): ReadableStream<UIMessageChunk> {
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

/**
 * The title a new conversation starts with: its first line, or the server's placeholder, which
 * stays English in every language so that the server still replaces it with a generated title.
 */
function firstLineTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return NEW_CONVERSATION_TITLE;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}
