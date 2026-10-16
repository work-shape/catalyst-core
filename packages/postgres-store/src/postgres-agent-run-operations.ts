import { lockAgentRunConversations } from "./postgres-agent-run-locks";
import { requestAgentRunCancellation } from "./postgres-agent-run-cancellation";
import { decideWaitingToolCall } from "./postgres-agent-run-decision-operations";
import {
  appendClaimedAgentRunEnd,
  appendClaimedAgentRunMessage,
  appendClaimedRunObservation,
  assertClaimedAgentRun,
  claimAgentRunForJob,
  failAgentRunsQueuedTooLong,
  failAgentRunsWithoutWorker,
  failLostAgentRun,
  listAgentRunsInProgress,
  listAgentRunsWithoutJob,
  renewAgentRunJobLease
} from "./postgres-agent-run-worker-operations";
import { and, asc, desc, eq, gt, isNull, lt, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  type AgentRun,
  type AgentRunId,
  type AppendRunObservationInput,
  type ClaimRunStartCommandInput,
  type ClaimRunStartCommandResult,
  type ClientInstanceId,
  type CompleteRunStartCommandInput,
  type ConversationId,
  type CreateAgentRunInput,
  type PrepareConversationRunStartInput,
  type PreparedConversationRunStart,
  type ConversationRunStartResult,
  type ReleaseRunStartCommandInput,
  type RunObservation,
  agentRunJobOptions,
  asAgentRunId,
  asClientInstanceId,
  executeAgentRunJob,
  asConversationId,
  asMessageId,
  type RunStartCommand,
  type UpdateAgentRunStatusInput,
  type ChatMessage,
  type AssertClaimedAgentRunInput,
  type AgentRunStore,
  type AppendClaimedAgentRunMessageInput,
  type AppendClaimedRunObservationInput,
  type RequestAgentRunCancellationInput,
  type RunObservationStore,
  type AgentRunsStore
} from "@work-shape/catalyst-core";
import { queueFollowUp, observeFollowUpChange, mapFollowUp } from "./postgres-follow-up-operations";
import { enqueueJob } from "./jobs/store";
import { lockActiveConversation } from "./postgres-conversation-operations";
import { type PostgresConnection } from "./postgres-database";
import { mapAgentRun, mapMessage, mapRunObservation } from "./rows";
import {
  agentRunObservations,
  agentRuns,
  conversationFollowUps,
  conversationAttachments,
  conversations,
  messages,
  platformJobs,
  runStartCommands
} from "./schema";

async function claimRunStartCommand(
  db: PostgresConnection,
  input: ClaimRunStartCommandInput
): Promise<ClaimRunStartCommandResult> {
  const now = input.createdAt ? new Date(input.createdAt) : new Date();
  const [inserted] = await db
    .insert(runStartCommands)
    .values({
      clientInstanceId: input.clientInstanceId,
      ownerUserId: input.ownerUserId,
      idempotencyKey: input.idempotencyKey,
      commandKind: input.commandKind,
      status: "pending",
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    return {
      status: "claimed",
      command: mapRunStartCommand(inserted)
    };
  }

  if (input.reclaimPendingBefore) {
    const [reclaimed] = await db
      .update(runStartCommands)
      .set({
        status: "pending",
        conversationId: null,
        userMessageId: null,
        runId: null,
        updatedAt: now
      })
      .where(
        and(
          runStartCommandWhere(input),
          eq(runStartCommands.status, "pending"),
          lt(runStartCommands.updatedAt, new Date(input.reclaimPendingBefore))
        )
      )
      .returning();
    if (reclaimed) {
      return {
        status: "claimed",
        command: mapRunStartCommand(reclaimed)
      };
    }
  }

  const existing = await getRunStartCommand(db, input);
  if (!existing) {
    throw new AppError("CONFLICT", "Run start command idempotency key already exists");
  }
  return {
    status: "existing",
    command: existing
  };
}

async function completeRunStartCommand(
  db: PostgresConnection,
  input: CompleteRunStartCommandInput
): Promise<RunStartCommand> {
  const [row] = await db
    .update(runStartCommands)
    .set({
      status: "completed",
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
      runId: input.runId,
      updatedAt: new Date(input.updatedAt)
    })
    .where(runStartCommandPendingClaimWhere(input))
    .returning();
  if (!row) {
    throw new AppError("NOT_FOUND", "Run start command is not available");
  }
  return mapRunStartCommand(row);
}

async function releaseRunStartCommand(
  db: PostgresConnection,
  input: ReleaseRunStartCommandInput
): Promise<void> {
  await db.delete(runStartCommands).where(runStartCommandPendingClaimWhere(input));
}

async function prepareConversationRunStart(
  db: PostgresConnection,
  input: PrepareConversationRunStartInput
): Promise<ConversationRunStartResult> {
  return db.transaction(async (tx) => {
    if (!(await lockActiveConversation(tx, input.clientInstanceId, input.conversationId))) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }

    const [activeRun] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.clientInstanceId, input.clientInstanceId),
          eq(agentRuns.conversationId, input.conversationId),
          drizzleSql`${agentRuns.status} in ('queued', 'running', 'waiting_for_decision', 'cancelling')`
        )
      )
      .limit(1);
    if (activeRun) {
      if (input.followUp === "queue" && !input.dispatchFollowUpId)
        return { followUp: await queueFollowUp(tx, input) };
      throw new AppError("CONFLICT", "Conversation already has an active agent run");
    }

    if (input.dispatchFollowUpId) {
      const [latest] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.clientInstanceId, input.clientInstanceId),
            eq(agentRuns.conversationId, input.conversationId)
          )
        )
        .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id))
        .limit(1);
      if (latest?.id !== input.dispatchAfterRunId)
        throw new AppError("CONFLICT", "Dispatch belongs to an earlier turn");
      const [oldest] = await tx
        .select()
        .from(conversationFollowUps)
        .where(
          and(
            eq(conversationFollowUps.clientInstanceId, input.clientInstanceId),
            eq(conversationFollowUps.conversationId, input.conversationId),
            eq(conversationFollowUps.status, "pending")
          )
        )
        .orderBy(asc(conversationFollowUps.position))
        .limit(1);
      if (
        !oldest ||
        oldest.id !== input.dispatchFollowUpId ||
        oldest.authorUserId !== input.ownerUserId
      )
        throw new AppError("CONFLICT", "Follow-up is no longer the oldest pending message");
    }
    const createdAt = input.run.startedAt ? new Date(input.run.startedAt) : new Date();
    const [earlierUserMessage] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.clientInstanceId, input.clientInstanceId),
          eq(messages.conversationId, input.conversationId),
          eq(messages.role, "user")
        )
      )
      .limit(1);
    const [messageRow] = await tx
      .insert(messages)
      .values({
        id: input.userMessage.id,
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        role: "user",
        text: input.userMessage.text,
        createdAt,
        metadata: input.userMessage.metadata ?? {}
      })
      .returning();
    if (input.claimReadyDraftAttachments || input.dispatchFollowUpId) {
      await tx
        .update(conversationAttachments)
        .set({
          messageId: input.userMessage.id,
          updatedAt: createdAt
        })
        .where(
          and(
            eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
            eq(conversationAttachments.conversationId, input.conversationId),
            eq(conversationAttachments.status, "ready"),
            isNull(conversationAttachments.messageId),
            input.dispatchFollowUpId
              ? eq(conversationAttachments.followUpId, input.dispatchFollowUpId)
              : isNull(conversationAttachments.followUpId)
          )
        );
    }

    const [runRow] = await tx
      .insert(agentRuns)
      .values({
        id: input.run.id,
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        ownerUserId: input.ownerUserId,
        inputMessageId: input.userMessage.id,
        agentName: input.run.agentName,
        modelBindingId: input.run.modelBindingId,
        reasoningEffort: input.run.reasoningEffort,
        locale: input.run.locale,
        authorizationContext: input.run.authorization,
        status: input.run.status ?? "queued",
        idempotencyKey: input.run.idempotencyKey,
        startedAt: createdAt,
        updatedAt: createdAt,
        lastSequence: 0,
        correlationId: input.run.correlationId
      })
      .returning();

    if (input.dispatchFollowUpId) {
      const [item] = await tx
        .update(conversationFollowUps)
        .set({ status: "dispatched", dispatchedRunId: input.run.id, updatedAt: createdAt })
        .where(eq(conversationFollowUps.id, input.dispatchFollowUpId))
        .returning();
      if (!item) throw new AppError("CONFLICT", "Follow-up is not available");
      await observeFollowUpChange(tx, mapFollowUp(item));
      // Release this wake-up's dedupe key before its new run can complete. Its concurrency
      // key stays held until the handler ends, so a fast next completion cannot lose a wake-up.
      if (input.dispatchJobId)
        await tx
          .update(platformJobs)
          .set({ dedupeKey: null })
          .where(
            and(
              eq(platformJobs.id, input.dispatchJobId),
              eq(platformJobs.kind, "conversation.follow_up.dispatch")
            )
          );
    }
    if (input.runStartCommand) {
      const [commandRow] = await tx
        .update(runStartCommands)
        .set({
          status: "completed",
          conversationId: input.conversationId,
          userMessageId: input.userMessage.id,
          runId: input.run.id,
          updatedAt: createdAt
        })
        .where(
          and(
            runStartCommandWhere({
              clientInstanceId: input.clientInstanceId,
              ownerUserId: input.ownerUserId,
              commandKind: input.runStartCommand.commandKind,
              idempotencyKey: input.runStartCommand.idempotencyKey
            }),
            eq(runStartCommands.status, "pending"),
            ...(input.runStartCommand.claimedAt
              ? [eq(runStartCommands.updatedAt, new Date(input.runStartCommand.claimedAt))]
              : [])
          )
        )
        .returning();
      if (!commandRow) {
        throw new AppError("NOT_FOUND", "Run start command is not available");
      }
    }

    // The row is locked, so the expiry claim reads the moved date or has already claimed the
    // Conversation. `greatest` keeps a later date, and of two messages the later one.
    await tx
      .update(conversations)
      .set({
        updatedAt: createdAt,
        ...(input.extendRetentionDays === undefined
          ? {}
          : {
              retainedUntil: drizzleSql<Date>`greatest(${conversations.retainedUntil}, now() + make_interval(days => ${input.extendRetentionDays}))`
            })
      })
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.id, input.conversationId)
        )
      );

    // The run and its job are accepted together: no run waits without a job, and no job
    // finds its run missing.
    const run = mapAgentRun(runRow);
    if (run.status === "queued") {
      await enqueueJob(tx, executeAgentRunJob, { runId: run.id }, agentRunJobOptions(run));
    }

    return {
      userMessage: mapMessage(messageRow),
      run,
      firstUserMessage: earlierUserMessage === undefined
    };
  });
}

async function createAgentRun(
  db: PostgresConnection,
  input: CreateAgentRunInput
): Promise<AgentRun> {
  const now = input.startedAt ? new Date(input.startedAt) : new Date();
  const [row] = await db
    .insert(agentRuns)
    .values({
      id: input.id,
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      inputMessageId: input.inputMessageId,
      agentName: input.agentName,
      modelBindingId: input.modelBindingId,
      reasoningEffort: input.reasoningEffort,
      locale: input.locale,
      authorizationContext: input.authorization,
      status: input.status ?? "running",
      idempotencyKey: input.idempotencyKey,
      startedAt: now,
      updatedAt: now,
      lastSequence: 0,
      correlationId: input.correlationId
    })
    .returning();
  return mapAgentRun(row);
}

async function getAgentRun(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
  }
): Promise<AgentRun | undefined> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(
      and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, input.runId))
    )
    .limit(1);
  return row ? mapAgentRun(row) : undefined;
}

async function getConversationAgentRun(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    runId: AgentRunId;
  }
): Promise<AgentRun | undefined> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, input.clientInstanceId),
        eq(agentRuns.conversationId, input.conversationId),
        eq(agentRuns.id, input.runId)
      )
    )
    .limit(1);
  return row ? mapAgentRun(row) : undefined;
}

async function getActiveConversationAgentRun(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<AgentRun | undefined> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, input.clientInstanceId),
        eq(agentRuns.conversationId, input.conversationId),
        drizzleSql`${agentRuns.status} in ('queued', 'running', 'waiting_for_decision', 'cancelling')`
      )
    )
    .limit(1);
  return row ? mapAgentRun(row) : undefined;
}

async function getLatestConversationAgentRun(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<AgentRun | undefined> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, input.clientInstanceId),
        eq(agentRuns.conversationId, input.conversationId)
      )
    )
    .orderBy(desc(agentRuns.startedAt))
    .limit(1);
  return row ? mapAgentRun(row) : undefined;
}

async function updateAgentRunStatus(
  db: PostgresConnection,
  input: UpdateAgentRunStatusInput
): Promise<AgentRun> {
  const [row] = await db
    .update(agentRuns)
    .set({
      status: input.status,
      updatedAt: new Date(input.updatedAt),
      lastSequence: input.lastSequence,
      completedAt: input.completedAt ? new Date(input.completedAt) : undefined,
      cancelledAt: input.cancelledAt ? new Date(input.cancelledAt) : undefined,
      failedAt: input.failedAt ? new Date(input.failedAt) : undefined,
      error: input.error
    })
    .where(
      and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, input.runId))
    )
    .returning();
  if (!row) {
    throw new AppError("NOT_FOUND", "Agent run is not available");
  }
  return mapAgentRun(row);
}

async function appendRunObservation(
  db: PostgresConnection,
  input: AppendRunObservationInput
): Promise<RunObservation> {
  return db.transaction(async (tx) => {
    await lockAgentRunConversations(tx, input.clientInstanceId, [input.runId]);
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.clientInstanceId, input.clientInstanceId),
          eq(agentRuns.conversationId, input.conversationId),
          eq(agentRuns.id, input.runId)
        )
      )
      .limit(1);
    if (!run) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }

    const [row] = await tx
      .insert(agentRunObservations)
      .values({
        clientInstanceId: input.clientInstanceId,
        runId: input.runId,
        conversationId: input.conversationId,
        ownerUserId: run.ownerUserId,
        sequence: input.event.sequence,
        type: input.event.type,
        payload: input.event,
        createdAt: new Date(input.event.createdAt)
      })
      .returning();

    await tx
      .update(agentRuns)
      .set({
        lastSequence: drizzleSql<number>`greatest(${agentRuns.lastSequence}, ${input.event.sequence})`,
        updatedAt: new Date(input.event.createdAt)
      })
      .where(
        and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, input.runId))
      );

    return mapRunObservation(row);
  });
}

async function listRunObservations(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
    afterSequence?: number;
    limit?: number;
  }
): Promise<RunObservation[]> {
  const query = db
    .select()
    .from(agentRunObservations)
    .where(
      and(
        eq(agentRunObservations.clientInstanceId, input.clientInstanceId),
        eq(agentRunObservations.runId, input.runId),
        gt(agentRunObservations.sequence, input.afterSequence ?? 0)
      )
    )
    .orderBy(asc(agentRunObservations.sequence));
  const rows = input.limit === undefined ? await query : await query.limit(input.limit);
  return rows.map(mapRunObservation);
}

async function getRunStartCommand(
  db: PostgresConnection,
  input: ClaimRunStartCommandInput
): Promise<RunStartCommand | undefined> {
  const [row] = await db
    .select()
    .from(runStartCommands)
    .where(runStartCommandWhere(input))
    .limit(1);
  return row ? mapRunStartCommand(row) : undefined;
}

function runStartCommandWhere(input: {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  commandKind: RunStartCommand["commandKind"];
  idempotencyKey: string;
}) {
  return and(
    eq(runStartCommands.clientInstanceId, input.clientInstanceId),
    eq(runStartCommands.ownerUserId, input.ownerUserId),
    eq(runStartCommands.commandKind, input.commandKind),
    eq(runStartCommands.idempotencyKey, input.idempotencyKey)
  );
}

function runStartCommandPendingClaimWhere(input: {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  commandKind: RunStartCommand["commandKind"];
  idempotencyKey: string;
  claimedAt?: string;
}) {
  return and(
    runStartCommandWhere(input),
    eq(runStartCommands.status, "pending"),
    ...(input.claimedAt ? [eq(runStartCommands.updatedAt, new Date(input.claimedAt))] : [])
  );
}

function mapRunStartCommand(row: typeof runStartCommands.$inferSelect): RunStartCommand {
  return {
    clientInstanceId: asClientInstanceId(row.clientInstanceId),
    ownerUserId: row.ownerUserId,
    idempotencyKey: row.idempotencyKey,
    commandKind: row.commandKind,
    status: row.status,
    conversationId: row.conversationId ? asConversationId(row.conversationId) : undefined,
    userMessageId: row.userMessageId ? asMessageId(row.userMessageId) : undefined,
    runId: row.runId ? asAgentRunId(row.runId) : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** `enqueued` is called for every job this store inserts, before its transaction commits. */
export function createPostgresAgentRunsStore(
  db: PostgresConnection,
  enqueued: () => void
): AgentRunsStore {
  function prepare(
    input: PrepareConversationRunStartInput & { followUp?: undefined }
  ): Promise<PreparedConversationRunStart>;
  function prepare(input: PrepareConversationRunStartInput): Promise<ConversationRunStartResult>;
  async function prepare(
    input: PrepareConversationRunStartInput
  ): Promise<ConversationRunStartResult> {
    const result = await prepareConversationRunStart(db, input);
    if ("run" in result && result.run.status === "queued") enqueued();
    return result;
  }
  return {
    async claimRunStartCommand(
      input: ClaimRunStartCommandInput
    ): Promise<ClaimRunStartCommandResult> {
      return claimRunStartCommand(db, input);
    },
    async completeRunStartCommand(input: CompleteRunStartCommandInput) {
      return completeRunStartCommand(db, input);
    },
    async releaseRunStartCommand(input: ReleaseRunStartCommandInput): Promise<void> {
      return releaseRunStartCommand(db, input);
    },
    prepareConversationRunStart: prepare,
    async createAgentRun(input: Parameters<AgentRunStore["createAgentRun"]>[0]): Promise<AgentRun> {
      return createAgentRun(db, input);
    },
    async getAgentRun(input: {
      clientInstanceId: ClientInstanceId;
      runId: AgentRunId;
    }): Promise<AgentRun | undefined> {
      return getAgentRun(db, input);
    },
    async getConversationAgentRun(input: {
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      runId: AgentRunId;
    }): Promise<AgentRun | undefined> {
      return getConversationAgentRun(db, input);
    },
    async getActiveConversationAgentRun(input: {
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      ownerUserId: string;
    }): Promise<AgentRun | undefined> {
      return getActiveConversationAgentRun(db, input);
    },
    async getLatestConversationAgentRun(
      input: Parameters<AgentRunStore["getLatestConversationAgentRun"]>[0]
    ): Promise<AgentRun | undefined> {
      return getLatestConversationAgentRun(db, input);
    },
    async updateAgentRunStatus(input: UpdateAgentRunStatusInput): Promise<AgentRun> {
      return updateAgentRunStatus(db, input);
    },
    async claimAgentRunForJob(input: Parameters<AgentRunStore["claimAgentRunForJob"]>[0]) {
      return claimAgentRunForJob(db, input);
    },
    async renewAgentRunJobLease(input: Parameters<AgentRunStore["renewAgentRunJobLease"]>[0]) {
      return renewAgentRunJobLease(db, input);
    },
    async failLostAgentRun(input: Parameters<AgentRunStore["failLostAgentRun"]>[0]) {
      return failLostAgentRun(db, input);
    },
    async failAgentRunsQueuedTooLong(
      input: Parameters<AgentRunStore["failAgentRunsQueuedTooLong"]>[0]
    ) {
      return failAgentRunsQueuedTooLong(db, input);
    },
    async failAgentRunsWithoutWorker(
      input: Parameters<AgentRunStore["failAgentRunsWithoutWorker"]>[0]
    ) {
      return failAgentRunsWithoutWorker(db, input);
    },
    async listAgentRunsWithoutJob(input: Parameters<AgentRunStore["listAgentRunsWithoutJob"]>[0]) {
      return listAgentRunsWithoutJob(db, input);
    },
    decideWaitingToolCall: (input) => decideWaitingToolCall(db, input, enqueued),
    async requestAgentRunCancellation(input: RequestAgentRunCancellationInput): Promise<AgentRun> {
      return requestAgentRunCancellation(db, input);
    },
    async listAgentRunsInProgress(
      input: Parameters<AgentRunsStore["listAgentRunsInProgress"]>[0]
    ): Promise<AgentRun[]> {
      return listAgentRunsInProgress(db, input);
    },
    async appendClaimedRunObservation(
      input: AppendClaimedRunObservationInput
    ): Promise<RunObservation> {
      return appendClaimedRunObservation(db, input);
    },
    async assertClaimedAgentRun(input: AssertClaimedAgentRunInput): Promise<AgentRun> {
      return assertClaimedAgentRun(db, input);
    },
    async appendClaimedAgentRunEnd(
      input: Parameters<AgentRunStore["appendClaimedAgentRunEnd"]>[0]
    ) {
      await appendClaimedAgentRunEnd(db, input);
      if (input.events.some((event) => event.type === "run_completed")) enqueued();
    },
    async appendClaimedAgentRunMessage(
      input: AppendClaimedAgentRunMessageInput
    ): Promise<ChatMessage> {
      return appendClaimedAgentRunMessage(db, input);
    },
    async appendRunObservation(input: AppendRunObservationInput): Promise<RunObservation> {
      return appendRunObservation(db, input);
    },
    async listRunObservations(input: Parameters<RunObservationStore["listRunObservations"]>[0]) {
      return listRunObservations(db, input);
    }
  };
}
