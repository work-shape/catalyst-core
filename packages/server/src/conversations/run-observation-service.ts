import {
  ACTIVE_AGENT_RUN_STATUSES,
  AppError,
  auditActorFromUser,
  getSubjectUserId,
  projectAgentRun,
  readAssistantFinalMetadata,
  withoutAssistantProviderContinuation,
  type ActiveRunSummary,
  type AgentRun,
  type AgentRunId,
  type AgentRunProjection,
  type AgentRunStatus,
  type AgentRuntimeCommand,
  type AgentRuntimeEvent,
  type AgentRuntimeObserveOptions,
  type AuthenticatedUser,
  type ChatMessage,
  type ConversationId,
  type ConversationThreadSnapshot,
  type PlatformStores,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { requireConversationAccess } from "./conversation-access";
import { ConversationWorkflow } from "./conversation-service";

export class RunObservationWorkflow {
  private readonly options: ChatServerOptions;
  private readonly conversations: ConversationWorkflow;

  constructor(options: ChatServerOptions) {
    this.options = options;
    this.conversations = new ConversationWorkflow(options);
  }

  async listMessages(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<ChatMessage[]> {
    await this.conversations.requireConversationAccess(conversationId, user);
    const messages = await this.options.stores.conversations.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    return messages.map(toPublicChatMessage);
  }

  /**
   * The thread at one moment. A follow-up that starts meanwhile leaves the queue in the same
   * commit that adds its message and run, so the snapshot shows it in one place or the other,
   * never in neither: a page that read neither had no run to follow and no queue to wait for.
   */
  async getThreadSnapshot(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<ConversationThreadSnapshot> {
    return this.options.stores.readSnapshot(async (stores) => {
      const clientInstanceId = this.options.clientInstanceId;
      const conversation = await requireConversationAccess(
        { stores, clientInstanceId },
        conversationId,
        user
      );
      const messages = await stores.conversations.listMessages({
        clientInstanceId,
        conversationId
      });
      const activeRun = await stores.agentRuns.getActiveConversationAgentRun({
        clientInstanceId,
        conversationId
      });
      const latestRun = activeRun
        ? undefined
        : await stores.agentRuns.getLatestConversationAgentRun({
            clientInstanceId,
            conversationId
          });
      const latestVisibleTerminalRun =
        latestRun?.status === "failed" || latestRun?.status === "cancelled" ? latestRun : undefined;
      const runForSnapshot = activeRun ?? latestVisibleTerminalRun;
      const latestRunOfAnyStatus = activeRun ?? latestRun;
      const serverTime = new Date().toISOString();
      const completedRunProjections = await this.createCompletedRunProjections(
        stores,
        conversationId,
        messages,
        runForSnapshot?.id
      );

      return {
        conversation,
        followUps: await stores.followUps.listPending({ clientInstanceId, conversationId }),
        messages: messages.map(toPublicChatMessage),
        ...(Object.keys(completedRunProjections).length > 0 ? { completedRunProjections } : {}),
        ...(runForSnapshot
          ? {
              activeRun: {
                run: toActiveRunSummary(runForSnapshot),
                projection: await this.createRunProjection(stores, runForSnapshot)
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
          clientInstanceId,
          conversationId,
          userId: getSubjectUserId(user),
          updatedAt: serverTime
        },
        serverTime
      };
    });
  }

  private async createCompletedRunProjections(
    stores: PlatformStores,
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
      const run = await stores.agentRuns.getConversationAgentRun({
        clientInstanceId: this.options.clientInstanceId,
        conversationId,
        runId
      });
      if (!run || isActiveAgentRunStatus(run.status)) {
        continue;
      }
      const observations = await stores.agentRuns.listRunObservations({
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
    await this.conversations.requireConversationAccess(persistedRun.conversationId, context.user);

    let lastSequence = options.afterSequence ?? 0;
    const readStored = () =>
      this.options.stores.agentRuns.listRunObservations({
        clientInstanceId: this.options.clientInstanceId,
        runId,
        afterSequence: lastSequence
      });
    for (const observation of await readStored()) {
      lastSequence = Math.max(lastSequence, observation.sequence);
      yield observation.payload;
    }

    const latestRun =
      (await this.options.stores.agentRuns.getAgentRun({
        clientInstanceId: this.options.clientInstanceId,
        runId
      })) ?? persistedRun;
    if (!isActiveAgentRunStatus(latestRun.status)) {
      // A worker may have stored events and the end of the run between the two reads above. The
      // run has ended, so one more read holds everything that was not delivered.
      if (lastSequence < latestRun.lastSequence) {
        for (const observation of await readStored()) yield observation.payload;
      }
      return;
    }

    yield* this.options.agentRuntime.observe(runId, context, {
      afterSequence: lastSequence
    });
  }

  async getRunStatus(runId: AgentRunId, context: RuntimeCallContext): Promise<AgentRunStatus> {
    const run = await this.options.stores.agentRuns.getAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      runId
    });
    if (run) {
      await this.conversations.requireConversationAccess(run.conversationId, context.user);
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
    await this.conversations.requireConversationAccess(run.conversationId, user);
    return run;
  }

  async getConversationRunForUser(
    conversationId: ConversationId,
    runId: AgentRunId,
    user: AuthenticatedUser
  ): Promise<AgentRun | undefined> {
    await this.conversations.requireConversationAccess(conversationId, user);
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

  private async createRunProjection(
    stores: PlatformStores,
    run: AgentRun
  ): Promise<AgentRunProjection> {
    const observations = await stores.agentRuns.listRunObservations({
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

    await this.options.agentRuntime.cancel(runId, reason, context);
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
}

function toPublicChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    metadata: withoutAssistantProviderContinuation(message.metadata)
  };
}

function isActiveAgentRunStatus(
  status: AgentRunStatus
): status is Extract<AgentRunStatus, (typeof ACTIVE_AGENT_RUN_STATUSES)[number]> {
  return ACTIVE_AGENT_RUN_STATUSES.some((active) => active === status);
}

function toActiveRunSummary(run: AgentRun): ActiveRunSummary {
  return {
    id: run.id,
    conversationId: run.conversationId,
    agentName: run.agentName,
    ownerUserId: run.ownerUserId,
    inputMessageId: run.inputMessageId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    lastSequence: run.lastSequence
  };
}
