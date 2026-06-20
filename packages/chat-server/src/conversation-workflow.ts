import { auditActorFromUser } from "@vivd-catalyst/core";
import {
  AppError,
  type AttachmentManifest,
  type AgentRunId,
  type AgentRuntimeEvent,
  type AuthenticatedUser,
  type ChatMessage,
  type Conversation,
  type ConversationId,
  type JsonObject,
  type RuntimeCallContext,
  addDays,
  createPlatformId,
  isAppError
} from "@vivd-catalyst/core";
import { getModelSelectionForConversationTitles } from "@vivd-catalyst/config-schema";
import type { ModelMessage } from "@vivd-catalyst/model-provider";
import { createEmptyAttachmentManifest } from "./attachments";
import {
  isTemporaryConversationTitle,
  normalizeGeneratedConversationTitle
} from "./conversation-title";
import type { ChatServerOptions } from "./types";

export interface CreateConversationCommand {
  title?: string;
}

export interface SendConversationMessageCommand {
  agentName?: string;
  text: string;
}

export interface StartedConversationMessageRun {
  userMessage: ChatMessage;
  runId: AgentRunId;
}

const CONVERSATION_TITLE_AGENT_NAME = "conversation_title";
const MAX_TITLE_SOURCE_CHARS = 800;

export class ConversationWorkflow {
  private readonly options: ChatServerOptions;

  constructor(options: ChatServerOptions) {
    this.options = options;
  }

  async listConversations(user: AuthenticatedUser): Promise<Conversation[]> {
    return this.options.conversationStore.listConversationsForUser({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: user.id
    });
  }

  async createConversation(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: CreateConversationCommand
  ): Promise<Conversation> {
    const conversation = await this.options.conversationStore.createConversation({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: user.id,
      ownerExternalUserId: user.externalUserId,
      title: command.title ?? "New conversation",
      retainedUntil: addDays(new Date(), this.options.config.retention.conversationDays).toISOString()
    });

    await this.options.auditRecorder.record({
      type: "conversation.created",
      status: "success",
      actor: auditActorFromUser(user),
      subject: conversation.id,
      correlationId: context.correlationId,
      metadata: {
        retainedUntil: conversation.retainedUntil
      }
    });
    return conversation;
  }

  async listMessages(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<ChatMessage[]> {
    await this.requireOwnedActiveConversation(conversationId, user);
    return this.options.conversationStore.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
  }

  async startMessageRun(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: SendConversationMessageCommand
  ): Promise<StartedConversationMessageRun> {
    await this.requireOwnedActiveConversation(conversationId, user);
    const attachments = this.options.attachments;
    const draftAttachments = attachments
      ? await attachments.listDraftAttachments(conversationId)
      : [];
    const blockMessage = attachments?.blockingDraftAttachmentMessage(draftAttachments);
    if (blockMessage) {
      throw new AppError("CONFLICT", blockMessage);
    }
    const attachmentManifest =
      attachments?.createAttachmentManifest(draftAttachments) ?? createEmptyAttachmentManifest();
    const userMessageId = createPlatformId<"MessageId">("msg");
    const userMessage = await this.options.conversationStore.appendMessage({
      id: userMessageId,
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      role: "user",
      text: command.text,
      metadata: createUserMessageMetadata(attachmentManifest)
    });
    if (attachmentManifest.attachments.length > 0) {
      await this.options.conversationStore.claimReadyDraftAttachmentsForMessage({
        clientInstanceId: this.options.clientInstanceId,
        conversationId,
        messageId: userMessage.id,
        claimedAt: userMessage.createdAt
      });
    }

    await this.options.auditRecorder.record({
      type: "message.created",
      status: "success",
      actor: auditActorFromUser(user),
      subject: userMessage.id,
      correlationId: context.correlationId,
      metadata: {
        conversationId,
        attachmentCount: attachmentManifest.attachments.length
      }
    });

    const run = await this.options.agentRuntime.start(
      {
        agentName: command.agentName ?? this.options.config.defaultAgentName,
        conversationId,
        message: {
          text: command.text,
          attachmentManifest:
            attachmentManifest.attachments.length > 0 ? attachmentManifest : undefined
        }
      },
      context
    );

    return {
      userMessage,
      runId: run.runId
    };
  }

  observeRun(runId: AgentRunId, context: RuntimeCallContext): AsyncIterable<AgentRuntimeEvent> {
    return this.options.agentRuntime.observe(runId, context);
  }

  async persistAssistantMessage(
    conversationId: ConversationId,
    event: Extract<AgentRuntimeEvent, { type: "message_completed" }>
  ): Promise<ChatMessage> {
    return {
      id: event.message.id,
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      role: "assistant",
      text: event.message.text,
      createdAt: event.createdAt,
      metadata: event.message.metadata
    };
  }

  async recordRunCompleted(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    runId: AgentRunId,
    assistantMessageCount: number
  ): Promise<void> {
    await this.options.auditRecorder.record({
      type: "message.completed",
      status: "success",
      actor: auditActorFromUser(user),
      subject: conversationId,
      correlationId: context.correlationId,
      metadata: {
        assistantMessageCount,
        runId
      }
    });
  }

  async generateTitleForConversation(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<Conversation | undefined> {
    if (!this.options.config.conversationTitles.enabled) {
      return undefined;
    }

    const conversation = await this.requireOwnedActiveConversation(conversationId, user);
    const messages = await this.options.conversationStore.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    const firstUserMessage = findFirstUserMessage(messages);
    if (
      !firstUserMessage ||
      !isTemporaryConversationTitle(
        conversation.title,
        firstUserMessage.text,
        temporaryAttachmentTitles(firstUserMessage)
      )
    ) {
      return undefined;
    }

    const modelSelection = getModelSelectionForConversationTitles(this.options.config);
    const runId = createPlatformId<"AgentRunId">("run");

    try {
      const completion = await this.options.usageGovernance.runModelCall(
        this.options.clientInstanceId,
        async () => {
          const result = await this.options.modelProvider.complete(
            {
              providerId: modelSelection.provider.id,
              model: modelSelection.model,
              reasoningEffort: modelSelection.reasoningEffort,
              messages: createTitlePrompt(firstUserMessage),
              tools: []
            },
            context
          );
          await this.options.usageGovernance.appendModelUsageEvent({
            clientInstanceId: this.options.clientInstanceId,
            conversationId,
            agentRunId: runId,
            agentName: CONVERSATION_TITLE_AGENT_NAME,
            providerId: modelSelection.provider.id,
            model: modelSelection.model,
            correlationId: context.correlationId,
            ...result.usage
          });
          return result;
        }
      );
      const title = normalizeGeneratedConversationTitle(completion.text);
      if (!isUsableGeneratedTitle(title) || title === conversation.title) {
        return undefined;
      }

      const updated = await this.options.conversationStore.updateConversationTitle({
        clientInstanceId: this.options.clientInstanceId,
        conversationId,
        title,
        updatedAt: new Date().toISOString()
      });
      await this.options.auditRecorder.record({
        type: "conversation.title_generated",
        status: "success",
        actor: auditActorFromUser(user),
        subject: conversationId,
        correlationId: context.correlationId,
        metadata: {
          runId,
          providerId: modelSelection.provider.id,
          model: modelSelection.model,
          previousTitleLength: conversation.title.length,
          generatedTitleLength: title.length
        }
      });
      return updated;
    } catch (error) {
      await this.options.auditRecorder.record({
        type: "conversation.title_generation_failed",
        status: "failed",
        actor: auditActorFromUser(user),
        subject: conversationId,
        correlationId: context.correlationId,
        metadata: {
          runId,
          providerId: modelSelection.provider.id,
          model: modelSelection.model,
          ...toAuditErrorMetadata(error)
        }
      });
      return undefined;
    }
  }

  async recordRunFailed(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    runId: AgentRunId,
    assistantMessageCount: number,
    event: Extract<AgentRuntimeEvent, { type: "run_failed" }>
  ): Promise<void> {
    await this.options.auditRecorder.record({
      type: "message.failed",
      status: "failed",
      actor: auditActorFromUser(user),
      subject: conversationId,
      correlationId: context.correlationId,
      metadata: {
        assistantMessageCount,
        errorCode: event.error.code,
        runId
      }
    });
  }

  async deleteConversation(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<Conversation> {
    if (!this.options.config.retention.allowUserDelete) {
      throw new AppError("FORBIDDEN", "User conversation deletion is disabled for this client instance");
    }
    await this.requireOwnedActiveConversation(conversationId, user);
    const deleted = await this.options.conversationStore.deleteConversation({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      deletedAt: new Date().toISOString()
    });
    await this.options.auditRecorder.record({
      type: "conversation.deleted",
      status: "success",
      actor: auditActorFromUser(user),
      subject: deleted.id,
      correlationId: context.correlationId
    });
    return deleted;
  }

  async requireOwnedActiveConversation(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<Conversation> {
    const conversation = await this.options.conversationStore.getConversation(
      this.options.clientInstanceId,
      conversationId
    );
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    if (conversation.ownerUserId !== user.id) {
      throw new AppError("FORBIDDEN", "Conversation belongs to another user");
    }
    return conversation;
  }

}

function createUserMessageMetadata(attachmentManifest: AttachmentManifest): JsonObject | undefined {
  if (attachmentManifest.attachments.length === 0) {
    return undefined;
  }
  return {
    agentRuntime: {
      version: 1,
      kind: "user_message",
      attachmentManifest: toJsonAttachmentManifest(attachmentManifest)
    }
  };
}

function toJsonAttachmentManifest(attachmentManifest: AttachmentManifest): JsonObject {
  const attachments = attachmentManifest.attachments.map((attachment): JsonObject => {
    const entry: JsonObject = {
      kind: attachment.kind,
      fileId: attachment.fileId,
      attachmentId: attachment.attachmentId,
      filename: attachment.filename,
      byteSize: attachment.byteSize,
      status: attachment.status
    };
    if (attachment.mimeType) {
      entry.mimeType = attachment.mimeType;
    }
    if (attachment.readable !== undefined) {
      entry.readable = attachment.readable;
    }
    if (attachment.modelVisibility) {
      entry.modelVisibility = {
        type: attachment.modelVisibility.type,
        mimeType: attachment.modelVisibility.mimeType
      };
    }
    if (attachment.modelContext) {
      entry.modelContext = {
        section: attachment.modelContext.section,
        text: attachment.modelContext.text
      };
    }
    if (attachment.metadata) {
      entry.metadata = attachment.metadata;
    }
    return entry;
  });

  return {
    version: attachmentManifest.version,
    attachments
  };
}

function findFirstUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find((message) => message.role === "user");
}

function temporaryAttachmentTitles(message: ChatMessage): string[] {
  const attachments = readAttachmentManifestEntries(message);
  if (attachments.length === 0) {
    return [];
  }

  const filenames = attachments
    .map((attachment) => (typeof attachment.filename === "string" ? attachment.filename : undefined))
    .filter((filename): filename is string => Boolean(filename));

  return [
    ...filenames,
    attachments.length === 1 ? "Attached file" : `${attachments.length} attached files`
  ];
}

function readAttachmentManifestEntries(message: ChatMessage): JsonObject[] {
  const runtime = readAgentRuntimeMetadata(message);
  const manifest = runtime?.kind === "user_message" ? runtime.attachmentManifest : undefined;
  if (!isJsonObject(manifest) || manifest.version !== 1 || !Array.isArray(manifest.attachments)) {
    return [];
  }
  return manifest.attachments.filter(isJsonObject);
}

function readAgentRuntimeMetadata(message: ChatMessage): JsonObject | undefined {
  const runtime = message.metadata?.agentRuntime;
  if (!isJsonObject(runtime) || runtime.version !== 1) {
    return undefined;
  }
  return runtime;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createTitlePrompt(firstUserMessage: ChatMessage): ModelMessage[] {
  return [
    {
      role: "system",
      content: [
        "Generate a short neutral headline/topic for a persisted conversation list.",
        "Infer the conversation topic from the initial user message only.",
        "The title should describe the overall likely conversation, not quote or answer the user message.",
        "Use 3 to 7 words.",
        "Do not include names, addresses, emails, phone numbers, bank details, exact salary amounts, IDs, or other personal data.",
        "If the content is sensitive, use a generic topic label.",
        "Return only the headline text."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "Initial user message:",
        truncateTitleSource(firstUserMessage.text)
      ].join("\n")
    }
  ];
}

function truncateTitleSource(text: string): string {
  const normalized = text
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ");
  return normalized.length > MAX_TITLE_SOURCE_CHARS
    ? `${normalized.slice(0, MAX_TITLE_SOURCE_CHARS).trimEnd()}...`
    : normalized;
}

function isUsableGeneratedTitle(title: string): boolean {
  return title.length > 0 && title !== "New conversation";
}

function toAuditErrorMetadata(error: unknown): JsonObject {
  if (isAppError(error)) {
    return {
      errorCode: error.code,
      errorMessage: error.message
    };
  }
  if (error instanceof Error) {
    return {
      errorCode: "INTERNAL",
      errorMessage: error.message
    };
  }
  return {
    errorCode: "INTERNAL",
    errorMessage: "Conversation title generation failed"
  };
}
