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
  type ReleaseRunStartCommandInput,
  type RunObservation,
  agentRunJobOptions,
  asAgentRunId,
  asClientInstanceId,
  executeAgentRunJob,
  asConversationId,
  asMessageId,
  type RunStartCommand,
  type UpdateAgentRunStatusInput
} from "@vivd-catalyst/core";
import { enqueueJob } from "./jobs/store";
import { lockActiveConversation } from "./postgres-conversation-operations";
import type { PostgresConnection } from "./postgres-database";
import { mapAgentRun, mapMessage, mapRunObservation } from "./rows";
import {
  agentRunObservations,
  agentRuns,
  conversationAttachments,
  conversations,
  messages,
  runStartCommands
} from "./schema";

export async function claimRunStartCommand(
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

export async function completeRunStartCommand(
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

export async function releaseRunStartCommand(
  db: PostgresConnection,
  input: ReleaseRunStartCommandInput
): Promise<void> {
  await db.delete(runStartCommands).where(runStartCommandPendingClaimWhere(input));
}

export async function prepareConversationRunStart(
  db: PostgresConnection,
  input: PrepareConversationRunStartInput
): Promise<PreparedConversationRunStart> {
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
          drizzleSql`${agentRuns.status} in ('queued', 'running', 'waiting_for_permission', 'cancelling')`
        )
      )
      .limit(1);
    if (activeRun) {
      throw new AppError("CONFLICT", "Conversation already has an active agent run");
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
    if (input.claimReadyDraftAttachments) {
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
            isNull(conversationAttachments.messageId)
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

export async function createAgentRun(
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

export async function getAgentRun(
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

export async function getConversationAgentRun(
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

export async function getActiveConversationAgentRun(
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
        drizzleSql`${agentRuns.status} in ('queued', 'running', 'waiting_for_permission', 'cancelling')`
      )
    )
    .limit(1);
  return row ? mapAgentRun(row) : undefined;
}

export async function getLatestConversationAgentRun(
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

export async function updateAgentRunStatus(
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

export {
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
  renewAgentRunJobLease,
  requestAgentRunCancellation
} from "./postgres-agent-run-worker-operations";

export async function appendRunObservation(
  db: PostgresConnection,
  input: AppendRunObservationInput
): Promise<RunObservation> {
  return db.transaction(async (tx) => {
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

export async function listRunObservations(
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
