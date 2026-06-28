import { auditActorFromUser } from "@vivd-catalyst/core";
import {
  AppError,
  type AgentRun,
  type ActiveRunSummary,
  type AgentRunProjection,
  type AgentRunId,
  type AgentRunStatus,
  type AgentRuntimeCommand,
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
  type RunStartCommand,
  type RunStartCommandKind,
  addDays,
  createUserMessageMetadata,
  createPlatformId,
  getRuntimeSubjectUserId,
  getSubjectUserId,
  isAppError,
  readUserMessageMetadata
} from "@vivd-catalyst/core";
import { getModelSelectionForConversationTitles } from "@vivd-catalyst/config-schema";
import type { ModelMessage } from "@vivd-catalyst/model-provider";
import { createEmptyAttachmentManifest } from "./attachments";
import {
  createConversationTitle,
  isTemporaryConversationTitle,
  normalizeGeneratedConversationTitle
} from "./conversation-title";
import {
  isMissingLocalRuntimeState,
  recoverStaleRun,
  recoveryEventFromObservation
} from "./run-recovery";
import type { ChatServerOptions } from "./types";

export interface CreateConversationCommand {
  title?: string;
}

export interface SendConversationMessageCommand {
  agentName?: string;
  idempotencyKey?: string;
  text: string;
}

export interface StartedConversationMessageRun {
  userMessage: ChatMessage;
  run: AgentRun;
  runId: AgentRunId;
}

const CONVERSATION_TITLE_AGENT_NAME = "conversation_title";
const MAX_TITLE_SOURCE_CHARS = 800;
const IDEMPOTENCY_WAIT_ATTEMPTS = 100;
const IDEMPOTENCY_WAIT_MS = 10;
const IDEMPOTENCY_PENDING_RECLAIM_MS = 5 * 60 * 1000;

export class ConversationWorkflow {
  private readonly options: ChatServerOptions;

  constructor(options: ChatServerOptions) {
    this.options = options;
  }

  async listConversations(user: AuthenticatedUser): Promise<ConversationListItem[]> {
    const subjectUserId = getSubjectUserId(user);
    const conversations = await this.options.conversationStore.listConversationsForUser({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: subjectUserId
    });
    return Promise.all(
      conversations.map(async (conversation): Promise<ConversationListItem> => {
        const activeRun = await this.options.conversationStore.getActiveConversationAgentRun({
          clientInstanceId: this.options.clientInstanceId,
          conversationId: conversation.id,
          ownerUserId: subjectUserId
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
    const subjectUserId = getSubjectUserId(user);
    const conversation = await this.options.conversationStore.createConversation({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: subjectUserId,
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
      ownerUserId: getSubjectUserId(user)
    });
    const recovered = activeRun ? await recoverStaleRun(this.options, activeRun) : undefined;
    const runForSnapshot = recovered?.run ?? activeRun;
    const serverTime = new Date().toISOString();

    return {
      conversation,
      messages,
      ...(runForSnapshot
        ? {
            activeRun: {
              run: toActiveRunSummary(runForSnapshot),
              projection: await this.createRunProjection(runForSnapshot, user)
            }
          }
        : {}),
      // Synthetic until a backend read-marker mutation makes unread/read state product scope.
      userState: {
        clientInstanceId: this.options.clientInstanceId,
        conversationId,
        userId: getSubjectUserId(user),
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
    let runStartCommand: RunStartCommand | undefined;
    if (command.idempotencyKey) {
      const claim = await this.claimOrResolveRunStartCommand({
        commandKind: "start_conversation_run",
        conversationId,
        idempotencyKey: command.idempotencyKey,
        user
      });
      if (claim.status === "resolved") {
        return claim.started;
      }
      runStartCommand = claim.command;
    }

    try {
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
      const runId = createPlatformId<"AgentRunId">("run");
      const startedAt = new Date().toISOString();
      const prepared = await this.options.conversationStore.prepareConversationRunStart({
        clientInstanceId: this.options.clientInstanceId,
        conversationId,
        ownerUserId: getSubjectUserId(user),
        userMessage: {
          id: userMessageId,
          text: command.text,
          metadata: createUserMessageMetadata({ attachmentManifest })
        },
        run: {
          id: runId,
          clientInstanceId: this.options.clientInstanceId,
          conversationId,
          ownerUserId: getSubjectUserId(user),
          inputMessageId: userMessageId,
          agentName: command.agentName ?? this.options.config.defaultAgentName,
          idempotencyKey: command.idempotencyKey,
          correlationId: context.correlationId,
          startedAt
        },
        ...(command.idempotencyKey
          ? {
              runStartCommand: {
                idempotencyKey: command.idempotencyKey,
                commandKind: "start_conversation_run" as const,
                claimedAt: runStartCommand?.updatedAt
              }
            }
          : {}),
        claimReadyDraftAttachments: attachmentManifest.attachments.length > 0
      });

      const run = await this.options.agentRuntime.start(
        {
          agentName: prepared.run.agentName,
          conversationId,
          idempotencyKey: command.idempotencyKey,
          inputMessageId: prepared.userMessage.id,
          preparedRun: {
            id: prepared.run.id,
            startedAt: prepared.run.startedAt
          },
          message: {
            text: command.text,
            attachmentManifest:
              attachmentManifest.attachments.length > 0 ? attachmentManifest : undefined
          }
        },
        context
      );
      if (run.runId !== prepared.run.id) {
        throw new AppError("INTERNAL", "Prepared agent run id was not started");
      }

      await this.options.auditRecorder.record({
        type: "message.created",
        status: "success",
        actor: auditActorFromUser(user),
        subject: prepared.userMessage.id,
        correlationId: context.correlationId,
        metadata: {
          conversationId,
          attachmentCount: attachmentManifest.attachments.length
        }
      });

      return {
        userMessage: prepared.userMessage,
        run: prepared.run,
        runId: prepared.run.id
      };
    } catch (error) {
      if (command.idempotencyKey) {
        await this.releaseRunStartCommand(
          command.idempotencyKey,
          "start_conversation_run",
          user,
          runStartCommand?.updatedAt
        );
      }
      throw error;
    }
  }

  async createConversationAndStartMessageRun(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: SendConversationMessageCommand & CreateConversationCommand
  ): Promise<{ conversation: Conversation; userMessage: ChatMessage; run: AgentRun; runId: AgentRunId }> {
    let runStartCommand: RunStartCommand | undefined;
    if (command.idempotencyKey) {
      const claim = await this.claimOrResolveRunStartCommand({
        commandKind: "create_conversation_run",
        idempotencyKey: command.idempotencyKey,
        user
      });
      if (claim.status === "resolved") {
        const conversation = await this.requireOwnedActiveConversation(
          claim.started.run.conversationId,
          user
        );
        return {
          conversation,
          ...claim.started
        };
      }
      runStartCommand = claim.command;
    }

    try {
      const conversation = await this.createConversation(user, context, {
        title: command.title ?? createConversationTitle(command.text)
      });
      const started = await this.startMessageRun(conversation.id, user, context, {
        ...command,
        idempotencyKey: undefined
      });
      if (command.idempotencyKey) {
        await this.options.conversationStore.completeRunStartCommand({
          clientInstanceId: this.options.clientInstanceId,
          ownerUserId: getSubjectUserId(user),
          idempotencyKey: command.idempotencyKey,
          commandKind: "create_conversation_run",
          claimedAt: runStartCommand?.updatedAt,
          conversationId: conversation.id,
          userMessageId: started.userMessage.id,
          runId: started.runId,
          updatedAt: started.run.startedAt
        });
      }
      return {
        conversation,
        ...started
      };
    } catch (error) {
      if (command.idempotencyKey) {
        await this.releaseRunStartCommand(
          command.idempotencyKey,
          "create_conversation_run",
          user,
          runStartCommand?.updatedAt
        );
      }
      throw error;
    }
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
    if (persistedRun.ownerUserId !== getRuntimeSubjectUserId(context)) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }

    let lastSequence = options.afterSequence ?? 0;
    const observations = await this.options.conversationStore.listRunObservations({
      clientInstanceId: this.options.clientInstanceId,
      runId,
      ownerUserId: getRuntimeSubjectUserId(context),
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
      if (isMissingLocalRuntimeState(error)) {
        const staleRun =
          (await this.options.conversationStore.getAgentRun({
            clientInstanceId: this.options.clientInstanceId,
            runId
          })) ?? latestRun;
        if (staleRun.ownerUserId === getRuntimeSubjectUserId(context)) {
          const recovered = await recoverStaleRun(this.options, staleRun);
          const recoveryEvent = recoveryEventFromObservation(recovered?.observation);
          if (recoveryEvent && recoveryEvent.sequence > lastSequence) {
            yield recoveryEvent;
          }
          if (recovered || observations.length > 0) {
            return;
          }
        }
      }
      throw error;
    }
  }

  async getRunStatus(runId: AgentRunId, context: RuntimeCallContext): Promise<AgentRunStatus> {
    const run = await this.options.conversationStore.getAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      runId
    });
    if (run?.ownerUserId === getRuntimeSubjectUserId(context)) {
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
    return run?.ownerUserId === getSubjectUserId(user) ? run : undefined;
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
    const subjectUserId = getSubjectUserId(user);
    if (!run || run.ownerUserId !== subjectUserId) {
      return undefined;
    }

    const conversation = await this.options.conversationStore.getConversation(
      this.options.clientInstanceId,
      conversationId
    );
    if (!conversation || conversation.status !== "active" || conversation.ownerUserId !== subjectUserId) {
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
      ownerUserId: getSubjectUserId(user),
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

  async commandRun(
    conversationId: ConversationId,
    runId: AgentRunId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: AgentRuntimeCommand
  ): Promise<AgentRun> {
    const run = await this.getConversationRunForUser(conversationId, runId, user);
    if (!run) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }
    await this.options.agentRuntime.resume(runId, command, context);
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
    if (conversation.ownerUserId !== getSubjectUserId(user)) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    return conversation;
  }

  private async claimOrResolveRunStartCommand(input: {
    commandKind: RunStartCommandKind;
    conversationId?: ConversationId;
    idempotencyKey: string;
    user: AuthenticatedUser;
  }): Promise<
    | { status: "claimed"; command: RunStartCommand }
    | { status: "resolved"; started: StartedConversationMessageRun }
  > {
    const claimInput = {
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: getSubjectUserId(input.user),
      idempotencyKey: input.idempotencyKey,
      commandKind: input.commandKind,
      reclaimPendingBefore: new Date(Date.now() - IDEMPOTENCY_PENDING_RECLAIM_MS).toISOString()
    };

    let claim = await this.options.conversationStore.claimRunStartCommand(claimInput);
    if (claim.status === "claimed") {
      return { status: "claimed", command: claim.command };
    }

    for (let attempt = 0; attempt < IDEMPOTENCY_WAIT_ATTEMPTS; attempt += 1) {
      if (claim.command.status === "completed") {
        return {
          status: "resolved",
          started: await this.startedRunFromCommand(claim.command, input.user, input.conversationId)
        };
      }

      if (claim.command.status === "failed") {
        throw new AppError("CONFLICT", "Run start command previously failed");
      }

      await delay(IDEMPOTENCY_WAIT_MS);
      claim = await this.options.conversationStore.claimRunStartCommand(claimInput);
      if (claim.status === "claimed") {
        return { status: "claimed", command: claim.command };
      }
    }

    throw new AppError("CONFLICT", "Run start command is still pending");
  }

  private async startedRunFromCommand(
    command: RunStartCommand,
    user: AuthenticatedUser,
    expectedConversationId?: ConversationId
  ): Promise<StartedConversationMessageRun> {
    if (!command.conversationId || !command.userMessageId || !command.runId) {
      throw new AppError("CONFLICT", "Run start command is still pending");
    }
    if (expectedConversationId && command.conversationId !== expectedConversationId) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }
    await this.requireOwnedActiveConversation(command.conversationId, user);
    const run = await this.options.conversationStore.getConversationAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      conversationId: command.conversationId,
      runId: command.runId
    });
    if (!run || run.ownerUserId !== getSubjectUserId(user)) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }
    return {
      userMessage: await this.requireRunInputMessage(run),
      run,
      runId: run.id
    };
  }

  private async releaseRunStartCommand(
    idempotencyKey: string,
    commandKind: RunStartCommandKind,
    user: AuthenticatedUser,
    claimedAt: string | undefined
  ): Promise<void> {
    await this.options.conversationStore.releaseRunStartCommand({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: getSubjectUserId(user),
      idempotencyKey,
      commandKind,
      claimedAt
    });
  }

  private async requireRunInputMessage(run: AgentRun): Promise<ChatMessage> {
    const messages = await this.options.conversationStore.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId: run.conversationId
    });
    const message = messages.find((candidate) => candidate.id === run.inputMessageId);
    if (!message) {
      throw new AppError("INTERNAL", "Agent run input message was not persisted");
    }
    return message;
  }

}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const runtime = readUserMessageMetadata(message.metadata);
  const manifest = runtime?.attachmentManifest;
  if (!isJsonObject(manifest) || manifest.version !== 1 || !Array.isArray(manifest.attachments)) {
    return [];
  }
  return manifest.attachments.filter(isJsonObject);
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
  const parts: AgentRunProjection["parts"] = [];
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
      appendProjectionTextPart(parts, event.delta);
    }

    if (event.type === "reasoning_delta") {
      const reasoning = reasoningById.get(event.id) ?? {
        id: event.id,
        text: "",
        open: true
      };
      reasoning.text += event.delta;
      reasoningById.set(event.id, reasoning);
      upsertProjectionPart(parts, {
        type: "reasoning",
        id: event.id,
        text: reasoning.text,
        open: true
      });
    }

    if (event.type === "message_completed") {
      text = event.message.text;
      replaceLatestProjectionTextPart(parts, event.message.text);
    }

    if (event.type === "tool_call_started") {
      const toolCall = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        state: "input_available"
      } as const;
      toolCallsById.set(event.toolCallId, toolCall);
      upsertProjectionPart(parts, {
        type: "tool_call",
        ...toolCall
      });
    }

    if (event.type === "tool_permission_requested") {
      const existing = toolCallsById.get(event.toolCallId);
      const toolCall = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: existing?.input,
        state: "waiting_for_permission"
      } as const;
      toolCallsById.set(event.toolCallId, toolCall);
      upsertProjectionPart(parts, {
        type: "tool_call",
        ...toolCall
      });
    }

    if (event.type === "tool_call_completed") {
      const toolCall = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: toolCallsById.get(event.toolCallId)?.input,
        state: "output_available",
        output: toProjectionToolOutput(event)
      } as const;
      toolCallsById.set(event.toolCallId, toolCall);
      upsertProjectionPart(parts, {
        type: "tool_call",
        ...toolCall
      });
    }

    if (event.type === "tool_call_failed") {
      const toolCall = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: toolCallsById.get(event.toolCallId)?.input,
        state: "output_error",
        errorText: toProjectionToolError(event)
      } as const;
      toolCallsById.set(event.toolCallId, toolCall);
      upsertProjectionPart(parts, {
        type: "tool_call",
        ...toolCall
      });
    }

    if (event.type === "run_failed") {
      error = event.error;
    }

    if (event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed") {
      for (const reasoning of reasoningById.values()) {
        reasoning.open = false;
      }
      for (const part of parts) {
        if (part.type === "reasoning") {
          part.open = false;
        }
      }
    }
  }

  return {
    runId: run.id,
    lastSequence,
    status: run.status,
    parts,
    text,
    reasoning: [...reasoningById.values()],
    activeToolCalls: [...toolCallsById.values()],
    ...(error ? { error } : {})
  };
}

function appendProjectionTextPart(
  parts: AgentRunProjection["parts"],
  delta: string
): void {
  if (delta.length === 0) {
    return;
  }
  const lastPart = parts.at(-1);
  if (lastPart?.type === "text") {
    lastPart.text += delta;
    return;
  }
  parts.push({
    type: "text",
    text: delta
  });
}

function replaceLatestProjectionTextPart(
  parts: AgentRunProjection["parts"],
  text: string
): void {
  const latestTextPart = parts.findLast((part) => part.type === "text");
  if (latestTextPart) {
    latestTextPart.text = text;
    return;
  }
  if (text.length > 0 || parts.length === 0) {
    parts.push({
      type: "text",
      text
    });
  }
}

function upsertProjectionPart(
  parts: AgentRunProjection["parts"],
  part: AgentRunProjection["parts"][number]
): void {
  const index = parts.findIndex((candidate) => {
    if (candidate.type !== part.type) {
      return false;
    }
    if (part.type === "tool_call") {
      return candidate.type === "tool_call" && candidate.toolCallId === part.toolCallId;
    }
    if (part.type === "reasoning") {
      return candidate.type === "reasoning" && candidate.id === part.id;
    }
    return false;
  });
  if (index >= 0) {
    parts[index] = part;
    return;
  }
  parts.push(part);
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
