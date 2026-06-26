import { auditActorFromUser } from "@vivd-catalyst/core";
import {
  AppError,
  type AgentRun,
  type ActiveRunSummary,
  type AgentRunProjection,
  type AttachmentManifest,
  type AgentRunId,
  type AgentRunStatus,
  type AgentRuntimeEvent,
  type AgentRuntimeObserveOptions,
  type AuthenticatedUser,
  type ChatMessage,
  type Conversation,
  type ConversationListItem,
  type ConversationThreadSnapshot,
  type ConversationId,
  type JsonObject,
  type RuntimeCallContext,
  type RunObservation,
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

  async listConversations(user: AuthenticatedUser): Promise<ConversationListItem[]> {
    const conversations = await this.options.conversationStore.listConversationsForUser({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: user.id
    });
    return Promise.all(
      conversations.map(async (conversation): Promise<ConversationListItem> => {
        const activeRun = await this.options.conversationStore.getActiveConversationAgentRun({
          clientInstanceId: this.options.clientInstanceId,
          conversationId: conversation.id,
          ownerUserId: user.id
        });
        return {
          ...conversation,
          ...(activeRun ? { activeRun: toActiveRunSummary(activeRun) } : {})
        };
      })
    );
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

  async getThreadSnapshot(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<ConversationThreadSnapshot> {
    const conversation = await this.requireOwnedActiveConversation(conversationId, user);
    const messages = await this.options.conversationStore.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    const activeRun = await this.options.conversationStore.getActiveConversationAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      ownerUserId: user.id
    });
    const serverTime = new Date().toISOString();

    return {
      conversation,
      messages,
      ...(activeRun
        ? {
            activeRun: {
              run: toActiveRunSummary(activeRun),
              projection: await this.createRunProjection(activeRun, user)
            }
          }
        : {}),
      userState: {
        clientInstanceId: this.options.clientInstanceId,
        conversationId,
        userId: user.id,
        updatedAt: serverTime
      },
      serverTime
    };
  }

  async startMessageRun(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: SendConversationMessageCommand
  ): Promise<StartedConversationMessageRun> {
    await this.requireOwnedActiveConversation(conversationId, user);
    const activeRun = await this.options.conversationStore.getActiveConversationAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      ownerUserId: user.id
    });
    if (activeRun) {
      throw new AppError("CONFLICT", "Conversation already has an active agent run");
    }

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
        inputMessageId: userMessage.id,
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

  async *observeRun(
    runId: AgentRunId,
    context: RuntimeCallContext,
    options: AgentRuntimeObserveOptions = {}
  ): AsyncIterable<AgentRuntimeEvent> {
    const persistedRun = await this.options.conversationStore.getAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      runId
    });
    if (!persistedRun) {
      yield* this.options.agentRuntime.observe(runId, context, options);
      return;
    }
    if (persistedRun.ownerUserId !== context.user.id) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }

    let lastSequence = options.afterSequence ?? 0;
    const observations = await this.options.conversationStore.listRunObservations({
      clientInstanceId: this.options.clientInstanceId,
      runId,
      ownerUserId: context.user.id,
      afterSequence: lastSequence
    });
    for (const observation of observations) {
      lastSequence = Math.max(lastSequence, observation.sequence);
      yield observation.payload;
    }

    const latestRun =
      (await this.options.conversationStore.getAgentRun({
        clientInstanceId: this.options.clientInstanceId,
        runId
      })) ?? persistedRun;
    if (!isActiveAgentRunStatus(latestRun.status)) {
      return;
    }

    try {
      yield* this.options.agentRuntime.observe(runId, context, {
        afterSequence: lastSequence
      });
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND" && observations.length > 0) {
        return;
      }
      throw error;
    }
  }

  async getRunStatus(runId: AgentRunId, context: RuntimeCallContext): Promise<AgentRunStatus> {
    const run = await this.options.conversationStore.getAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      runId
    });
    if (run?.ownerUserId === context.user.id) {
      return run.status;
    }
    if (run) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }
    return this.options.agentRuntime.getStatus(runId, context);
  }

  async getRunForUser(
    runId: AgentRunId,
    user: AuthenticatedUser
  ): Promise<AgentRun | undefined> {
    const run = await this.options.conversationStore.getAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      runId
    });
    return run?.ownerUserId === user.id ? run : undefined;
  }

  async getConversationRunForUser(
    conversationId: ConversationId,
    runId: AgentRunId,
    user: AuthenticatedUser
  ): Promise<AgentRun | undefined> {
    const run = await this.options.conversationStore.getConversationAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      runId
    });
    if (!run || run.ownerUserId !== user.id) {
      return undefined;
    }

    const conversation = await this.options.conversationStore.getConversation(
      this.options.clientInstanceId,
      conversationId
    );
    if (!conversation || conversation.status !== "active" || conversation.ownerUserId !== user.id) {
      return undefined;
    }
    return run;
  }

  private async createRunProjection(
    run: AgentRun,
    user: AuthenticatedUser
  ): Promise<AgentRunProjection> {
    const observations = await this.options.conversationStore.listRunObservations({
      clientInstanceId: this.options.clientInstanceId,
      runId: run.id,
      ownerUserId: user.id,
      afterSequence: 0
    });
    return buildAgentRunProjection(run, observations);
  }

  async cancelRun(
    conversationId: ConversationId,
    runId: AgentRunId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    reason?: string
  ): Promise<AgentRun> {
    const run = await this.getConversationRunForUser(conversationId, runId, user);
    if (!run) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }
    if (!isActiveAgentRunStatus(run.status)) {
      return run;
    }

    await this.options.agentRuntime.cancel(runId, reason, context);
    return (
      (await this.options.conversationStore.getConversationAgentRun({
        clientInstanceId: this.options.clientInstanceId,
        conversationId,
        runId
      })) ?? run
    );
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
        errorCategory: event.error.category,
        errorCode: event.error.code,
        runId
      }
    });
  }

  async recordRunCancelled(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    runId: AgentRunId,
    assistantMessageCount: number,
    event: Extract<AgentRuntimeEvent, { type: "run_cancelled" }>
  ): Promise<void> {
    await this.options.auditRecorder.record({
      type: "message.cancelled",
      status: "success",
      actor: auditActorFromUser(user),
      subject: conversationId,
      correlationId: context.correlationId,
      metadata: {
        assistantMessageCount,
        runId,
        ...(event.reason ? { reason: event.reason } : {})
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
    const deletedAt = new Date().toISOString();
    const attachmentDeletion = this.options.attachments
      ? await this.options.attachments.deleteConversationAttachments({
          conversationId,
          deletedAt
        })
      : undefined;
    const deleted = await this.options.conversationStore.deleteConversation({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      deletedAt
    });
    await this.options.auditRecorder.record({
      type: "conversation.deleted",
      status: "success",
      actor: auditActorFromUser(user),
      subject: deleted.id,
      correlationId: context.correlationId,
      metadata: attachmentDeletion
        ? {
            attachmentCount: attachmentDeletion.attachmentCount,
            fileCount: attachmentDeletion.fileObjectKeys.length,
            artifactCount: attachmentDeletion.artifactObjectKeys.length
          }
        : undefined
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

function isActiveAgentRunStatus(
  status: AgentRunStatus
): status is Extract<AgentRunStatus, "queued" | "running" | "waiting_for_permission" | "cancelling"> {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_permission" ||
    status === "cancelling"
  );
}

function toActiveRunSummary(run: AgentRun): ActiveRunSummary {
  if (!isActiveAgentRunStatus(run.status)) {
    throw new AppError("INTERNAL", "Expected an active agent run");
  }
  return {
    id: run.id,
    conversationId: run.conversationId,
    agentName: run.agentName,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    lastSequence: run.lastSequence
  };
}

function buildAgentRunProjection(
  run: AgentRun,
  observations: RunObservation[]
): AgentRunProjection {
  let text = "";
  let lastSequence = run.lastSequence;
  let error = run.error;
  const reasoningById = new Map<string, { id: string; text: string; open: boolean }>();
  const toolCallsById = new Map<
    string,
    AgentRunProjection["activeToolCalls"][number]
  >();

  for (const observation of observations) {
    const event = observation.payload;
    lastSequence = Math.max(lastSequence, event.sequence);

    if (event.type === "message_delta") {
      text += event.delta;
    }

    if (event.type === "reasoning_delta") {
      const reasoning = reasoningById.get(event.id) ?? {
        id: event.id,
        text: "",
        open: true
      };
      reasoning.text += event.delta;
      reasoningById.set(event.id, reasoning);
    }

    if (event.type === "message_completed") {
      text = event.message.text;
    }

    if (event.type === "tool_call_started") {
      toolCallsById.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        state: "input_available"
      });
    }

    if (event.type === "tool_permission_requested") {
      const existing = toolCallsById.get(event.toolCallId);
      toolCallsById.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: existing?.input,
        state: "waiting_for_permission"
      });
    }

    if (event.type === "tool_call_completed") {
      toolCallsById.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: toolCallsById.get(event.toolCallId)?.input,
        state: "output_available",
        output: toProjectionToolOutput(event)
      });
    }

    if (event.type === "tool_call_failed") {
      toolCallsById.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: toolCallsById.get(event.toolCallId)?.input,
        state: "output_error",
        errorText: toProjectionToolError(event)
      });
    }

    if (event.type === "run_failed") {
      error = event.error;
    }

    if (event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed") {
      for (const reasoning of reasoningById.values()) {
        reasoning.open = false;
      }
    }
  }

  return {
    runId: run.id,
    lastSequence,
    status: run.status,
    text,
    reasoning: [...reasoningById.values()],
    activeToolCalls: [...toolCallsById.values()],
    ...(error ? { error } : {})
  };
}

function toProjectionToolOutput(
  event: Extract<AgentRuntimeEvent, { type: "tool_call_completed" }>
): unknown {
  if (event.result.status === "success") {
    return {
      status: "success",
      output: event.result.output,
      display: event.result.display,
      artifacts: event.result.artifacts,
      projectionNotice: event.projectionNotice
    };
  }
  return {
    status: event.result.status,
    error: event.result.error,
    projectionNotice: event.projectionNotice
  };
}

function toProjectionToolError(
  event: Extract<AgentRuntimeEvent, { type: "tool_call_failed" }>
): string {
  if (event.result.status === "success") {
    return "Tool call failed";
  }
  return event.result.error.message;
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
