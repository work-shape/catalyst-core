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
import {
  blockingDraftAttachmentMessage,
  createAttachmentManifest
} from "@vivd-catalyst/document-processing";
import { getModelProviderForConversationTitles } from "@vivd-catalyst/config-schema";
import type { ModelMessage } from "@vivd-catalyst/model-provider";
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
    const draftAttachments = await this.options.conversationStore.listDraftAttachments({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    const blockMessage = blockingDraftAttachmentMessage(draftAttachments);
    if (blockMessage) {
      throw new AppError("CONFLICT", blockMessage);
    }
    const attachmentManifest = createAttachmentManifest(
      draftAttachments,
      this.options.config.documents.preprocessing.preprocessingVersion
    );
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

  async generateTitleForFirstExchange(
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
    const firstExchange = findFirstExchange(messages);
    if (
      !firstExchange ||
      !isTemporaryConversationTitle(
        conversation.title,
        firstExchange.user.text,
        temporaryAttachmentTitles(firstExchange.user)
      )
    ) {
      return undefined;
    }

    const provider = getModelProviderForConversationTitles(this.options.config);
    const model = this.options.config.conversationTitles.model ?? provider.model;
    const runId = createPlatformId<"AgentRunId">("run");

    try {
      const completion = await this.options.usageGovernance.runModelCall(
        this.options.clientInstanceId,
        async () => {
          const result = await this.options.modelProvider.complete(
            {
              providerId: provider.id,
              model,
              messages: createTitlePrompt(firstExchange),
              tools: []
            },
            context
          );
          await this.options.usageGovernance.appendModelUsageEvent({
            clientInstanceId: this.options.clientInstanceId,
            conversationId,
            agentRunId: runId,
            agentName: CONVERSATION_TITLE_AGENT_NAME,
            providerId: provider.id,
            model,
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
          providerId: provider.id,
          model,
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
          providerId: provider.id,
          model,
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
  return {
    version: attachmentManifest.version,
    attachments: attachmentManifest.attachments.map((attachment) => ({
      fileId: attachment.fileId,
      attachmentId: attachment.attachmentId,
      filename: attachment.filename,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      byteSize: attachment.byteSize,
      status: attachment.status,
      readable: attachment.readable,
      readToolName: attachment.readToolName,
      metadata: {
        fileId: attachment.metadata.fileId,
        filename: attachment.metadata.filename,
        ...(attachment.metadata.mimeType ? { mimeType: attachment.metadata.mimeType } : {}),
        byteSize: attachment.metadata.byteSize,
        ...(attachment.metadata.format ? { format: attachment.metadata.format } : {}),
        ...(attachment.metadata.characterCount !== undefined
          ? { characterCount: attachment.metadata.characterCount }
          : {}),
        ...(attachment.metadata.wordCount !== undefined ? { wordCount: attachment.metadata.wordCount } : {}),
        ...(attachment.metadata.pageCount !== undefined ? { pageCount: attachment.metadata.pageCount } : {}),
        warnings: attachment.metadata.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message
        })),
        ...(attachment.metadata.preprocessingVersion
          ? { preprocessingVersion: attachment.metadata.preprocessingVersion }
          : {})
      }
    }))
  };
}

function findFirstExchange(messages: ChatMessage[]): { user: ChatMessage; assistant: ChatMessage } | undefined {
  const userMessages = messages.filter((message) => message.role === "user");
  if (userMessages.length !== 1) {
    return undefined;
  }

  const assistantMessages = messages.filter(
    (message) => message.role === "assistant" && !isAssistantToolCallMessage(message)
  );
  if (assistantMessages.length !== 1) {
    return undefined;
  }
  const [user] = userMessages;
  const [assistant] = assistantMessages;
  return user && assistant ? { user, assistant } : undefined;
}

function isAssistantToolCallMessage(message: ChatMessage): boolean {
  const runtime = readAgentRuntimeMetadata(message);
  return runtime?.kind === "assistant_tool_calls";
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

function createTitlePrompt(input: { user: ChatMessage; assistant: ChatMessage }): ModelMessage[] {
  return [
    {
      role: "system",
      content: [
        "Generate a short neutral headline for a persisted conversation list.",
        "Use 3 to 7 words.",
        "Do not include names, addresses, emails, phone numbers, bank details, exact salary amounts, IDs, or other personal data.",
        "If the content is sensitive, use a generic topic label.",
        "Return only the headline text."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "User message:",
        truncateTitleSource(input.user.text),
        "",
        "Assistant response:",
        truncateTitleSource(input.assistant.text)
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
