import { auditActorFromUser } from "@vivd-stage/core";
import {
  AppError,
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
} from "@vivd-stage/core";
import { getModelProviderForConversationTitles } from "@vivd-stage/config-schema";
import type { ModelMessage } from "@vivd-stage/model-provider";
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
    const userMessage = await this.options.conversationStore.appendMessage({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      role: "user",
      text: command.text
    });

    await this.options.auditRecorder.record({
      type: "message.created",
      status: "success",
      actor: auditActorFromUser(user),
      subject: userMessage.id,
      correlationId: context.correlationId,
      metadata: {
        conversationId
      }
    });

    const run = await this.options.agentRuntime.start(
      {
        agentName: command.agentName ?? this.options.config.defaultAgentName,
        conversationId,
        message: {
          text: command.text
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
    return this.options.conversationStore.appendMessage({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      role: "assistant",
      text: event.message.text,
      metadata: event.message.domainUi ? { domainUi: event.message.domainUi } : undefined
    });
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
    if (!firstExchange || !isTemporaryConversationTitle(conversation.title, firstExchange.user.text)) {
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

  private async requireOwnedActiveConversation(
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

function findFirstExchange(messages: ChatMessage[]): { user: ChatMessage; assistant: ChatMessage } | undefined {
  const visibleMessages = messages.filter((message) => message.role === "user" || message.role === "assistant");
  if (visibleMessages.length !== 2) {
    return undefined;
  }
  const [user, assistant] = visibleMessages;
  if (user?.role !== "user" || assistant?.role !== "assistant") {
    return undefined;
  }
  return { user, assistant };
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
