import type { StorePage } from "@vivd-catalyst/core";
import { auditActorFromUser, projectAgentRun } from "@vivd-catalyst/core";
import {
  AppError,
  JobLeaseLostError,
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
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type ConversationListItem,
  type ConversationThreadSnapshot,
  type ConversationId,
  type ConversationVisibility,
  type JobControl,
  type JsonObject,
  type ReasoningEffortConfig,
  type RuntimeCallContext,
  type RunStartCommand,
  type RunStartCommandKind,
  type UserId,
  addDays,
  asUserId,
  createUserMessageMetadata,
  createPlatformId,
  getAuthPrincipal,
  getAuthScopes,
  getSubjectUserId,
  withoutAssistantProviderContinuation,
  isAppError,
  defaultReasoningEffortForAgentBinding,
  isModelBindingUserSelectableForAgent,
  reasoningEffortChoiceForBinding,
  readAssistantFinalMetadata,
  readUserMessageMetadata
} from "@vivd-catalyst/core";
import {
  getModelSelectionForConversationTitles,
  resolveModelBinding
} from "@vivd-catalyst/config-schema";
import type { ModelMessage } from "@vivd-catalyst/model-provider";
import { getWorkspaceAssetSnapshot } from "./agent-availability";
import { createEmptyAttachmentManifest } from "./attachments";
import { CollaborationWorkspaceWorkflow } from "./collaboration-workspace-workflow";
import { attemptConversationDataCleanup } from "./conversation-cleanup";
import {
  createConversationTitle,
  isTemporaryConversationTitle,
  normalizeGeneratedConversationTitle
} from "./conversation-title";
import { isActiveRun, isMissingLocalRuntimeState, recoverInterruptedRun } from "./run-recovery";
import { generateConversationTitleJob } from "./job-kinds";
import type { ChatServerOptions } from "./types";

export interface CreateConversationCommand {
  title?: string;
  collaborationWorkspaceId?: CollaborationWorkspaceId;
}

export interface SendConversationMessageCommand {
  agentName?: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffortConfig;
  idempotencyKey?: string;
  text: string;
}

export interface MoveConversationCommand {
  collaborationWorkspaceId: CollaborationWorkspaceId;
  visibility?: ConversationVisibility;
}

export interface StartedConversationMessageRun {
  userMessage: ChatMessage;
  run: AgentRun;
  runId: AgentRunId;
}

const CONVERSATION_TITLE_AGENT_NAME = "conversation_title";
const MAX_TITLE_SOURCE_CHARS = 800;
// How long a repeated run start waits for the first one with the same idempotency key, and how
// often it looks. A caller that waits longer gets 409 "Run start command is still pending".
const IDEMPOTENCY_WAIT_MS = 10_000;
const IDEMPOTENCY_WAIT_STEP_MS = 100;
const IDEMPOTENCY_PENDING_RECLAIM_MS = 5 * 60 * 1000;

export class ConversationWorkflow {
  private readonly options: ChatServerOptions;
  private readonly workspaces: CollaborationWorkspaceWorkflow;

  constructor(options: ChatServerOptions) {
    this.options = options;
    this.workspaces = new CollaborationWorkspaceWorkflow(options);
  }

  /**
   * An agent that is unknown and one that is not available in this workspace are
   * indistinguishable to the caller. A requested model must be one this agent offers to
   * users: its own binding or one of its user-selectable bindings. A requested reasoning
   * effort must be one the model that will run offers to users.
   */
  private async resolveRunAgentName(
    workspace: CollaborationWorkspace,
    requestedAgentName: string | undefined,
    requestedModelBindingId: string | undefined,
    requestedReasoningEffort: ReasoningEffortConfig | undefined
  ): Promise<string> {
    const assets = await getWorkspaceAssetSnapshot(this.options, workspace);
    const agentName = requestedAgentName ?? assets.defaultAgentName;
    if (!agentName) {
      throw new AppError(
        "VALIDATION_FAILED",
        "No default agent is configured for this client instance yet"
      );
    }
    const agent = assets.agents.find((candidate) => candidate.name === agentName);
    if (requestedAgentName !== undefined && !agent) {
      throw new AppError("NOT_FOUND", `Agent '${requestedAgentName}' is not defined`);
    }
    if (
      requestedModelBindingId &&
      !(
        agent &&
        isModelBindingUserSelectableForAgent(
          agent,
          this.options.config.modelBindings,
          requestedModelBindingId
        )
      )
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Model binding '${requestedModelBindingId}' is not available for user selection`
      );
    }
    if (requestedReasoningEffort) {
      const bindingId = requestedModelBindingId ?? agent?.modelBindingId;
      const binding = this.options.config.modelBindings.find(
        (candidate) => candidate.id === bindingId
      );
      const selection = binding && resolveModelBinding(this.options.config, binding.id);
      const offered = selection
        ? reasoningEffortChoiceForBinding(
            binding,
            selection.provider,
            (agent && defaultReasoningEffortForAgentBinding(agent, binding)) ??
              selection.reasoningEffort
          ).selectable
        : [];
      if (!offered.includes(requestedReasoningEffort)) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Reasoning effort '${requestedReasoningEffort}' is not available for user selection`
        );
      }
    }
    return agentName;
  }

  async listConversations(
    collaborationWorkspaceId: CollaborationWorkspaceId | undefined,
    user: AuthenticatedUser,
    page?: StorePage,
    titleQuery?: string
  ): Promise<ConversationListItem[]> {
    if (!collaborationWorkspaceId) {
      const personal = (
        await this.options.stores.workspaces.listWorkspacesForUser({
          clientInstanceId: this.options.clientInstanceId,
          userId: asUserId(getSubjectUserId(user))
        })
      ).find((workspace) => workspace.kind === "personal");
      if (!personal) return [];
      collaborationWorkspaceId = personal.id;
    }
    await this.workspaces.requireWorkspaceAccess(user, collaborationWorkspaceId);
    const conversations = await this.options.stores.conversations.listConversationsForWorkspace({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      scope: { kind: "viewer", userId: getSubjectUserId(user) },
      titleQuery,
      page
    });
    return Promise.all(
      conversations.map(async (conversation): Promise<ConversationListItem> => {
        const activeRun = await this.options.stores.agentRuns.getActiveConversationAgentRun({
          clientInstanceId: this.options.clientInstanceId,
          conversationId: conversation.id
        });
        const runForList = activeRun;
        return {
          ...conversation,
          ...(runForList && isActiveRun(runForList)
            ? { activeRun: toActiveRunSummary(runForList) }
            : {})
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
    const workspace = await this.resolveTargetWorkspace(user, command.collaborationWorkspaceId);
    const conversation = await this.options.stores.conversations.createConversation({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: subjectUserId,
      createdByExternalUserId: user.externalUserId,
      visibility: workspace.defaultConversationVisibility,
      title: command.title ?? "New conversation",
      retainedUntil: addDays(
        new Date(),
        this.options.config.retention.conversationDays
      ).toISOString()
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
    await this.requireConversationAccess(conversationId, user);
    const messages = await this.options.stores.conversations.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    return messages.map(toPublicChatMessage);
  }

  async getThreadSnapshot(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<ConversationThreadSnapshot> {
    const conversation = await this.requireConversationAccess(conversationId, user);
    const messages = await this.options.stores.conversations.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    const activeRun = await this.options.stores.agentRuns.getActiveConversationAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    const latestRun = activeRun
      ? undefined
      : await this.options.stores.agentRuns.getLatestConversationAgentRun({
          clientInstanceId: this.options.clientInstanceId,
          conversationId
        });
    const latestVisibleTerminalRun =
      latestRun?.status === "failed" || latestRun?.status === "cancelled" ? latestRun : undefined;
    const runForSnapshot = activeRun ?? latestVisibleTerminalRun;
    const latestRunOfAnyStatus = activeRun ?? latestRun;
    const serverTime = new Date().toISOString();
    const completedRunProjections = await this.createCompletedRunProjections(
      conversationId,
      messages,
      runForSnapshot?.id
    );

    return {
      conversation,
      messages: messages.map(toPublicChatMessage),
      ...(Object.keys(completedRunProjections).length > 0 ? { completedRunProjections } : {}),
      ...(runForSnapshot
        ? {
            activeRun: {
              run: toActiveRunSummary(runForSnapshot),
              projection: await this.createRunProjection(runForSnapshot)
            }
          }
        : {}),
      ...(latestRunOfAnyStatus
        ? {
            modelSelection: {
              ...(latestRunOfAnyStatus.modelBindingId
                ? { modelBindingId: latestRunOfAnyStatus.modelBindingId }
                : {}),
              ...(latestRunOfAnyStatus.reasoningEffort
                ? { reasoningEffort: latestRunOfAnyStatus.reasoningEffort }
                : {})
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

  async renameConversation(
    conversationId: ConversationId,
    title: string,
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<Conversation> {
    const conversation = await this.requireConversationAccess(conversationId, user);
    if (conversation.title === title) {
      return conversation;
    }

    const updated = await this.options.stores.conversations.updateConversationTitle({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      title,
      updatedAt: new Date().toISOString()
    });
    await this.options.auditRecorder.record({
      type: "conversation.renamed",
      status: "success",
      actor: auditActorFromUser(user),
      subject: conversationId,
      correlationId: context.correlationId,
      metadata: {
        previousTitleLength: conversation.title.length,
        titleLength: title.length
      }
    });
    return updated;
  }

  async moveConversation(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: MoveConversationCommand
  ): Promise<Conversation> {
    const conversation = await this.requireConversationAccess(conversationId, user);
    const destination = await this.requireMemberWorkspace(user, command.collaborationWorkspaceId);
    if (conversation.collaborationWorkspaceId === command.collaborationWorkspaceId) {
      throw new AppError("VALIDATION_FAILED", "Conversation already belongs to this workspace");
    }
    const visibility: ConversationVisibility =
      destination.kind === "personal"
        ? "workspace"
        : (command.visibility ??
          (conversation.visibility === "private"
            ? "private"
            : destination.defaultConversationVisibility));
    if (visibility === "private" && conversation.createdByUserId !== getSubjectUserId(user)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Only the creator of a conversation can make it private"
      );
    }
    await this.workspaces.assertConversationIdle(conversationId);
    const moved = await this.options.stores.conversations.moveConversation({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      fromCollaborationWorkspaceId: conversation.collaborationWorkspaceId,
      toCollaborationWorkspaceId: command.collaborationWorkspaceId,
      visibility
    });
    await this.options.auditRecorder.record({
      type: "conversation.moved",
      status: "success",
      actor: auditActorFromUser(user),
      subject: conversationId,
      correlationId: context.correlationId,
      metadata: {
        fromCollaborationWorkspaceId: conversation.collaborationWorkspaceId,
        toCollaborationWorkspaceId: command.collaborationWorkspaceId
      }
    });
    return moved;
  }

  private async createCompletedRunProjections(
    conversationId: ConversationId,
    messages: ChatMessage[],
    activeRunId: AgentRunId | undefined
  ): Promise<Record<string, AgentRunProjection>> {
    const runIds = Array.from(
      new Set(
        messages.flatMap((message): AgentRunId[] => {
          if (message.role !== "assistant") {
            return [];
          }
          const runId = readAssistantFinalMetadata(message.metadata)?.runId;
          return runId && runId !== activeRunId ? [runId as AgentRunId] : [];
        })
      )
    );
    const projections: Record<string, AgentRunProjection> = {};
    for (const runId of runIds) {
      const run = await this.options.stores.agentRuns.getConversationAgentRun({
        clientInstanceId: this.options.clientInstanceId,
        conversationId,
        runId
      });
      if (!run || isActiveRun(run)) {
        continue;
      }
      const observations = await this.options.stores.agentRuns.listRunObservations({
        clientInstanceId: this.options.clientInstanceId,
        runId
      });
      if (observations.length === 0) {
        continue;
      }
      if (!observations.some((observation) => observation.payload.type === "message_completed")) {
        continue;
      }
      projections[runId] = projectAgentRun(run, observations);
    }
    return projections;
  }

  async startMessageRun(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: SendConversationMessageCommand
  ): Promise<StartedConversationMessageRun> {
    const conversation = await this.requireConversationAccess(conversationId, user);
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
      const agentName = await this.resolveRunAgentName(
        await this.requireMemberWorkspace(user, conversation.collaborationWorkspaceId),
        command.agentName,
        command.modelBindingId,
        command.reasoningEffort
      );
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
      // The title job is enqueued in the transaction that writes the first user message, so
      // the message never exists without it and the job never without the message.
      const prepared = await this.options.stores.transaction(async (stores) => {
        const prepared = await stores.agentRuns.prepareConversationRunStart({
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
            agentName,
            modelBindingId: command.modelBindingId,
            reasoningEffort: command.reasoningEffort,
            locale: context.locale,
            authorization: {
              principal: context.principal ?? getAuthPrincipal(user),
              subjectUserId: context.subjectUserId ?? getSubjectUserId(user),
              delegatedActor: context.delegatedActor ?? user.delegatedActor,
              scopes: [...(context.scopes ?? getAuthScopes(user))]
            },
            status: "queued",
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
          claimReadyDraftAttachments: attachmentManifest.attachments.length > 0,
          // Only a message a user sends counts as activity. Reading, renaming, moving and
          // background jobs never reach this call.
          ...(this.options.config.retention.extendOnActivity
            ? { extendRetentionDays: this.options.config.retention.conversationDays }
            : {})
        });
        if (prepared.firstUserMessage && this.options.config.conversationTitles.enabled) {
          await stores.jobs.enqueue(
            generateConversationTitleJob,
            { conversationId, userId: getSubjectUserId(user) },
            {
              clientInstanceId: this.options.clientInstanceId,
              subject: conversationId,
              dedupeKey: conversationId,
              concurrencyKey: conversationId,
              correlationId: context.correlationId
            }
          );
        }
        return prepared;
      });

      const run = await this.options.agentRuntime.start(
        {
          agentName: prepared.run.agentName,
          modelBindingId: prepared.run.modelBindingId,
          reasoningEffort: prepared.run.reasoningEffort,
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
  ): Promise<{
    conversation: Conversation;
    userMessage: ChatMessage;
    run: AgentRun;
    runId: AgentRunId;
  }> {
    let runStartCommand: RunStartCommand | undefined;
    if (command.idempotencyKey) {
      const claim = await this.claimOrResolveRunStartCommand({
        commandKind: "create_conversation_run",
        idempotencyKey: command.idempotencyKey,
        user
      });
      if (claim.status === "resolved") {
        const conversation = await this.requireConversationAccess(
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
      // Checked before the Conversation exists so a rejected agent or model leaves nothing behind.
      await this.resolveRunAgentName(
        await this.resolveTargetWorkspace(user, command.collaborationWorkspaceId),
        command.agentName,
        command.modelBindingId,
        command.reasoningEffort
      );
      const conversation = await this.createConversation(user, context, {
        title: command.title ?? createConversationTitle(command.text),
        collaborationWorkspaceId: command.collaborationWorkspaceId
      });
      const started = await this.startMessageRun(conversation.id, user, context, {
        ...command,
        idempotencyKey: undefined
      });
      if (command.idempotencyKey) {
        await this.options.stores.agentRuns.completeRunStartCommand({
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
    const persistedRun = await this.options.stores.agentRuns.getAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      runId
    });
    if (!persistedRun) {
      yield* this.options.agentRuntime.observe(runId, context, options);
      return;
    }
    await this.requireConversationAccess(persistedRun.conversationId, context.user);

    let lastSequence = options.afterSequence ?? 0;
    const observations = await this.options.stores.agentRuns.listRunObservations({
      clientInstanceId: this.options.clientInstanceId,
      runId,
      afterSequence: lastSequence
    });
    for (const observation of observations) {
      lastSequence = Math.max(lastSequence, observation.sequence);
      yield observation.payload;
    }

    const latestRun =
      (await this.options.stores.agentRuns.getAgentRun({
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
        if (observations.length > 0) {
          return;
        }
      }
      throw error;
    }
  }

  async getRunStatus(runId: AgentRunId, context: RuntimeCallContext): Promise<AgentRunStatus> {
    const run = await this.options.stores.agentRuns.getAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      runId
    });
    if (run) {
      await this.requireConversationAccess(run.conversationId, context.user);
      return run.status;
    }
    return this.options.agentRuntime.getStatus(runId, context);
  }

  async getRunForUser(runId: AgentRunId, user: AuthenticatedUser): Promise<AgentRun | undefined> {
    const run = await this.options.stores.agentRuns.getAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      runId
    });
    if (!run) return undefined;
    await this.requireConversationAccess(run.conversationId, user);
    return run;
  }

  async getConversationRunForUser(
    conversationId: ConversationId,
    runId: AgentRunId,
    user: AuthenticatedUser
  ): Promise<AgentRun | undefined> {
    await this.requireConversationAccess(conversationId, user);
    const run = await this.options.stores.agentRuns.getConversationAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      runId
    });
    if (!run) {
      return undefined;
    }
    return run;
  }

  private async createRunProjection(run: AgentRun): Promise<AgentRunProjection> {
    const observations = await this.options.stores.agentRuns.listRunObservations({
      clientInstanceId: this.options.clientInstanceId,
      runId: run.id,
      afterSequence: 0
    });
    return projectAgentRun(run, observations);
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

    try {
      await this.options.agentRuntime.cancel(runId, reason, context);
    } catch (error) {
      if (isMissingLocalRuntimeState(error)) {
        const recovered = await recoverInterruptedRun(this.options, run);
        if (recovered) {
          return recovered.run;
        }
      }
      throw error;
    }
    return (
      (await this.options.stores.agentRuns.getConversationAgentRun({
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
      (await this.options.stores.agentRuns.getConversationAgentRun({
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

  /**
   * The work of the `conversation.generate_title` job. It finishes without work when the
   * conversation or the user is gone or the title is no longer the temporary one. The title is
   * written under the job's lease and only over the title it was generated for, so a rename
   * during the model call stands. A failure is thrown, so the job is tried again.
   */
  async generateTitleForConversation(
    input: { conversationId: ConversationId; userId: UserId; correlationId: string },
    control: Pick<JobControl, "signal" | "transaction">
  ): Promise<void> {
    if (!this.options.config.conversationTitles.enabled) {
      return;
    }
    const { conversationId } = input;
    const user = await this.findActiveUser(input.userId);
    if (!user) {
      return;
    }
    const context: RuntimeCallContext = {
      user,
      clientInstanceId: this.options.clientInstanceId,
      correlationId: input.correlationId,
      signal: control.signal
    };
    let conversation: Conversation;
    try {
      conversation = await this.requireConversationAccess(conversationId, user);
    } catch (error) {
      if (isAppError(error) && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) {
        return;
      }
      throw error;
    }
    const messages = await this.options.stores.conversations.listMessages({
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
      return;
    }

    const modelSelection = getModelSelectionForConversationTitles(this.options.config);
    const runId = createPlatformId<"AgentRunId">("run");

    try {
      const attribution = {
        kind: "agent_run" as const,
        conversationId,
        runId,
        agentName: CONVERSATION_TITLE_AGENT_NAME,
        userId: input.userId
      };
      const completion = await this.options.usageGovernance.runModelCall(
        { clientInstanceId: this.options.clientInstanceId, attribution },
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
          await this.options.usageGovernance.recordModelUsage({
            clientInstanceId: this.options.clientInstanceId,
            attribution,
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
        return;
      }

      // One statement decides: a title the user wrote since the job read the conversation
      // is not the expected one and stays.
      const updated = await control.transaction((stores) =>
        stores.conversations.replaceConversationTitle({
          clientInstanceId: this.options.clientInstanceId,
          conversationId,
          expectedTitle: conversation.title,
          title,
          updatedAt: new Date().toISOString()
        })
      );
      if (!updated) {
        return;
      }
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
    } catch (error) {
      // An attempt that lost its lease was taken over; the attempt that holds it reports.
      if (error instanceof JobLeaseLostError) {
        throw error;
      }
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
      throw error;
    }
  }

  private async findActiveUser(userId: UserId): Promise<AuthenticatedUser | undefined> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const user = users.find((candidate) => candidate.id === userId);
    if (!user || user.status !== "active") {
      return undefined;
    }
    const identity = user.identities[0];
    return {
      id: user.id,
      externalUserId: identity?.externalUserId ?? user.id,
      displayLabel: user.displayLabel,
      email: user.email,
      roles: user.roles,
      permissionRefs: user.permissionRefs,
      permissions: user.permissions,
      clientInstanceId: user.clientInstanceId,
      authSource: identity?.authSource ?? "job",
      subjectUserId: user.id
    };
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
      throw new AppError(
        "FORBIDDEN",
        "User conversation deletion is disabled for this client instance"
      );
    }
    await this.requireConversationAccess(conversationId, user);
    const deletedAt = new Date().toISOString();
    const deleted = await this.options.stores.conversations.deleteConversation({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      deletedAt
    });
    // The Conversation is gone for the user from here on. A cleanup that fails is retried by
    // the retention job and does not fail the request.
    const cleanup = await attemptConversationDataCleanup(this.options, deleted.id, deletedAt);
    await this.options.auditRecorder.record({
      type: "conversation.deleted",
      status: "success",
      actor: auditActorFromUser(user),
      subject: deleted.id,
      correlationId: context.correlationId,
      metadata: { ...cleanup }
    });
    return deleted;
  }

  /**
   * The single access check for a Conversation and everything that hangs off it. A missing
   * Conversation, one in a workspace the caller is not a member of, and another member's
   * private Conversation are indistinguishable to the caller.
   */
  async requireConversationAccess(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<Conversation> {
    const conversation = await this.options.stores.conversations.getConversation(
      this.options.clientInstanceId,
      conversationId
    );
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    try {
      await this.workspaces.requireWorkspaceAccess(user, conversation.collaborationWorkspaceId);
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") {
        throw new AppError("NOT_FOUND", "Conversation is not available");
      }
      throw error;
    }
    if (
      conversation.visibility === "private" &&
      conversation.createdByUserId !== getSubjectUserId(user)
    ) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    return conversation;
  }

  private async resolveTargetWorkspace(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId | undefined
  ): Promise<CollaborationWorkspace> {
    return collaborationWorkspaceId
      ? this.requireMemberWorkspace(user, collaborationWorkspaceId)
      : this.options.stores.workspaces.ensurePersonalWorkspace({
          clientInstanceId: this.options.clientInstanceId,
          userId: asUserId(getSubjectUserId(user))
        });
  }

  private async requireMemberWorkspace(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<CollaborationWorkspace> {
    await this.workspaces.requireWorkspaceAccess(user, collaborationWorkspaceId);
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      collaborationWorkspaceId
    );
    if (!workspace) {
      throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    }
    return workspace;
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

    let claim = await this.options.stores.agentRuns.claimRunStartCommand(claimInput);
    if (claim.status === "claimed") {
      return { status: "claimed", command: claim.command };
    }

    for (let waitedMs = 0; waitedMs < IDEMPOTENCY_WAIT_MS; waitedMs += IDEMPOTENCY_WAIT_STEP_MS) {
      if (claim.command.status === "completed") {
        return {
          status: "resolved",
          started: await this.startedRunFromCommand(claim.command, input.user, input.conversationId)
        };
      }

      if (claim.command.status === "failed") {
        throw new AppError("CONFLICT", "Run start command previously failed");
      }

      await delay(IDEMPOTENCY_WAIT_STEP_MS);
      claim = await this.options.stores.agentRuns.claimRunStartCommand(claimInput);
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
    await this.requireConversationAccess(command.conversationId, user);
    const run = await this.options.stores.agentRuns.getConversationAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      conversationId: command.conversationId,
      runId: command.runId
    });
    if (!run) {
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
    await this.options.stores.agentRuns.releaseRunStartCommand({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: getSubjectUserId(user),
      idempotencyKey,
      commandKind,
      claimedAt
    });
  }

  private async requireRunInputMessage(run: AgentRun): Promise<ChatMessage> {
    const messages = await this.options.stores.conversations.listMessages({
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

function toPublicChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    metadata: withoutAssistantProviderContinuation(message.metadata)
  };
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
    .map((attachment) =>
      typeof attachment.filename === "string" ? attachment.filename : undefined
    )
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
): status is Extract<
  AgentRunStatus,
  "queued" | "running" | "waiting_for_permission" | "cancelling"
> {
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
      content: ["Initial user message:", truncateTitleSource(firstUserMessage.text)].join("\n")
    }
  ];
}

function truncateTitleSource(text: string): string {
  const normalized = text.split(/\s+/u).filter(Boolean).join(" ");
  return normalized.length > MAX_TITLE_SOURCE_CHARS
    ? `${normalized.slice(0, MAX_TITLE_SOURCE_CHARS).trimEnd()}...`
    : normalized;
}

function isUsableGeneratedTitle(title: string): boolean {
  return title.length > 0 && title !== "New conversation";
}

function toAuditErrorMetadata(error: unknown): JsonObject {
  return { errorCode: isAppError(error) ? error.code : "INTERNAL" };
}
