import { and, asc, desc, eq, gt, isNull, lt, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  type AgentRun,
  type AgentRunId,
  type AgentRuntimeEvent,
  type AppendClaimedRunObservationInput,
  type AppendRunObservationInput,
  type ClaimAgentRunInput,
  type ClaimRunStartCommandInput,
  type ClaimRunStartCommandResult,
  type ClientInstanceId,
  type CompleteRunStartCommandInput,
  type ConversationId,
  type CreateAgentRunInput,
  type HeartbeatAgentRunInput,
  type PrepareConversationRunStartInput,
  type PreparedConversationRunStart,
  type ReleaseRunStartCommandInput,
  type RecoverStaleAgentRunInput,
  type RecoverStaleAgentRunResult,
  type RecoverExpiredAgentRunsInput,
  type RequestAgentRunCancellationInput,
  type RunObservation,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asMessageId,
  type RunStartCommand,
  type UpdateAgentRunStatusInput
} from "@vivd-catalyst/core";
import type { PostgresDatabase } from "./postgres-database";
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
  input: ReleaseRunStartCommandInput
): Promise<void> {
  await db.delete(runStartCommands).where(runStartCommandPendingClaimWhere(input));
}

export async function prepareConversationRunStart(
  db: PostgresDatabase,
  input: PrepareConversationRunStartInput
): Promise<PreparedConversationRunStart> {
  return db.transaction(async (tx) => {
    const locked = (await tx.execute(drizzleSql<{ id: string }>`
      select id
      from conversations
      where client_instance_id = ${input.clientInstanceId}
        and id = ${input.conversationId}
        and status = 'active'
      for update
    `)) as unknown as Array<{ id: string }>;
    if (!locked[0]) {
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
        locale: input.run.locale,
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

    await tx
      .update(conversations)
      .set({ updatedAt: createdAt })
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.id, input.conversationId)
        )
      );

    return {
      userMessage: mapMessage(messageRow),
      run: mapAgentRun(runRow)
    };
  });
}

export async function createAgentRun(
  db: PostgresDatabase,
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
      locale: input.locale,
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
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

export async function listStaleActiveAgentRuns(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    staleUpdatedBefore: string;
    limit: number;
  }
): Promise<AgentRun[]> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, input.clientInstanceId),
        drizzleSql`${agentRuns.status} in ('queued', 'running', 'waiting_for_permission', 'cancelling')`,
        lt(agentRuns.updatedAt, new Date(input.staleUpdatedBefore))
      )
    )
    .orderBy(asc(agentRuns.updatedAt), asc(agentRuns.id))
    .limit(input.limit);
  return rows.map(mapAgentRun);
}

export async function recoverStaleAgentRun(
  db: PostgresDatabase,
  input: RecoverStaleAgentRunInput
): Promise<RecoverStaleAgentRunResult> {
  return db.transaction(async (tx) => {
    const [terminalObservation] = await tx
      .select()
      .from(agentRunObservations)
      .where(
        and(
          eq(agentRunObservations.clientInstanceId, input.clientInstanceId),
          eq(agentRunObservations.runId, input.runId),
          drizzleSql`${agentRunObservations.type} in ('run_completed', 'run_cancelled', 'run_failed')`
        )
      )
      .orderBy(desc(agentRunObservations.sequence))
      .limit(1);

    if (terminalObservation) {
      const patch = terminalRunPatchFromObservation(mapRunObservation(terminalObservation));
      const [row] = await tx
        .update(agentRuns)
        .set(patch)
        .where(staleActiveRunWhere(input))
        .returning();
      return row
        ? {
            status: "recovered",
            run: mapAgentRun(row)
          }
        : {
            status: "not_recovered"
          };
    }

    const [row] = await tx
      .update(agentRuns)
      .set({
        status: "failed",
        updatedAt: new Date(input.recoveredAt),
        failedAt: new Date(input.recoveredAt),
        lastSequence: drizzleSql<number>`${agentRuns.lastSequence} + 1`,
        error: input.error
      })
      .where(staleActiveRunWhere(input))
      .returning();
    if (!row) {
      return { status: "not_recovered" };
    }

    const sequence = row.lastSequence;
    const event = {
      type: "run_failed" as const,
      runId: input.runId,
      sequence,
      createdAt: input.recoveredAt,
      error: input.error
    };
    const [observationRow] = await tx
      .insert(agentRunObservations)
      .values({
        clientInstanceId: row.clientInstanceId,
        runId: row.id,
        conversationId: row.conversationId,
        ownerUserId: row.ownerUserId,
        sequence,
        type: "run_failed",
        payload: event,
        createdAt: new Date(input.recoveredAt)
      })
      .returning();

    return {
      status: "recovered",
      run: mapAgentRun(row),
      observation: mapRunObservation(observationRow)
    };
  });
}

export async function claimNextAgentRun(
  db: PostgresDatabase,
  input: ClaimAgentRunInput
): Promise<AgentRun | undefined> {
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(drizzleSql<{ id: string }>`
      with candidate as (
        select id
        from agent_runs
        where client_instance_id = ${input.clientInstanceId}
          and status = 'queued'
        order by started_at asc, id asc
        limit 1
        for update skip locked
      )
      update agent_runs ar
      set status = 'running',
          lease_owner = ${input.workerId},
          lease_token = ${input.leaseToken},
          lease_expires_at = ${input.leaseExpiresAt}::timestamptz,
          heartbeat_at = ${input.now}::timestamptz,
          updated_at = ${input.now}::timestamptz
      from candidate
      where ar.id = candidate.id
      returning ar.id
    `)) as unknown as Array<{ id: string }>;
    const runId = rows[0]?.id;
    if (!runId) return undefined;
    const [row] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, runId)))
      .limit(1);
    return row ? mapAgentRun(row) : undefined;
  });
}

export async function heartbeatAgentRun(
  db: PostgresDatabase,
  input: HeartbeatAgentRunInput
): Promise<AgentRun> {
  const heartbeatAt = new Date(input.heartbeatAt);
  const [row] = await db
    .update(agentRuns)
    .set({
      heartbeatAt,
      leaseExpiresAt: new Date(input.leaseExpiresAt),
      updatedAt: heartbeatAt
    })
    .where(activeLeaseWhere(input))
    .returning();
  if (!row) throw new AppError("CONFLICT", "Agent run lease is no longer active");
  return mapAgentRun(row);
}

export async function requestAgentRunCancellation(
  db: PostgresDatabase,
  input: RequestAgentRunCancellationInput
): Promise<AgentRun> {
  return db.transaction(async (tx) => {
    const locked = (await tx.execute(drizzleSql<{ status: AgentRun["status"] }>`
      select status
      from agent_runs
      where client_instance_id = ${input.clientInstanceId}
        and id = ${input.runId}
      for update
    `)) as unknown as Array<{ status: AgentRun["status"] }>;
    const status = locked[0]?.status;
    if (!status) throw new AppError("NOT_FOUND", "Agent run is not available");

    const requestedAt = new Date(input.requestedAt);
    if (status === "queued") {
      const [row] = await tx
        .update(agentRuns)
        .set({
          status: "cancelled",
          cancellationRequestedAt: requestedAt,
          cancellationReason: input.reason,
          cancelledAt: requestedAt,
          updatedAt: requestedAt,
          lastSequence: drizzleSql<number>`${agentRuns.lastSequence} + 1`
        })
        .where(
          and(
            eq(agentRuns.clientInstanceId, input.clientInstanceId),
            eq(agentRuns.id, input.runId),
            eq(agentRuns.status, "queued")
          )
        )
        .returning();
      if (!row) throw new AppError("CONFLICT", "Agent run status changed during cancellation");
      const event = {
        type: "run_cancelled" as const,
        runId: input.runId,
        sequence: row.lastSequence,
        createdAt: input.requestedAt,
        ...(input.reason ? { reason: input.reason } : {})
      };
      await tx.insert(agentRunObservations).values({
        clientInstanceId: row.clientInstanceId,
        runId: row.id,
        conversationId: row.conversationId,
        ownerUserId: row.ownerUserId,
        sequence: event.sequence,
        type: event.type,
        payload: event,
        createdAt: requestedAt
      });
      return mapAgentRun(row);
    }

    if (status === "running" || status === "waiting_for_permission" || status === "cancelling") {
      const [row] = await tx
        .update(agentRuns)
        .set({
          status: "cancelling",
          cancellationRequestedAt: requestedAt,
          cancellationReason: input.reason,
          updatedAt: requestedAt
        })
        .where(
          and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, input.runId))
        )
        .returning();
      return mapAgentRun(row);
    }

    const [row] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, input.runId))
      )
      .limit(1);
    return mapAgentRun(row);
  });
}

export async function appendClaimedRunObservation(
  db: PostgresDatabase,
  input: AppendClaimedRunObservationInput
): Promise<RunObservation> {
  if (input.event.runId !== input.runId) {
    throw new AppError("VALIDATION_FAILED", "Run observation belongs to another agent run");
  }
  return db.transaction(async (tx) => {
    const terminal = terminalStatusPatch(input.event);
    const [run] = await tx
      .update(agentRuns)
      .set({
        lastSequence: input.event.sequence,
        updatedAt: new Date(input.event.createdAt),
        ...(input.event.type === "tool_permission_requested"
          ? { status: "waiting_for_permission" as const }
          : {}),
        ...terminal
      })
      .where(and(activeLeaseWhere(input), eq(agentRuns.lastSequence, input.event.sequence - 1)))
      .returning();
    if (!run) throw new AppError("CONFLICT", "Agent run lease or observation sequence is stale");

    const [row] = await tx
      .insert(agentRunObservations)
      .values({
        clientInstanceId: run.clientInstanceId,
        runId: run.id,
        conversationId: run.conversationId,
        ownerUserId: run.ownerUserId,
        sequence: input.event.sequence,
        type: input.event.type,
        payload: input.event,
        createdAt: new Date(input.event.createdAt)
      })
      .returning();
    return mapRunObservation(row);
  });
}

export async function recoverExpiredAgentRuns(
  db: PostgresDatabase,
  input: RecoverExpiredAgentRunsInput
): Promise<AgentRun[]> {
  if (input.limit <= 0) return [];
  return db.transaction(async (tx) => {
    const staleRows = (await tx.execute(drizzleSql<{ id: string }>`
      select id
      from agent_runs
      where client_instance_id = ${input.clientInstanceId}
        and status in ('running', 'waiting_for_permission', 'cancelling')
        and lease_expires_at is not null
        and lease_expires_at < ${input.leaseExpiredBefore}::timestamptz
      order by lease_expires_at asc, id asc
      limit ${input.limit}
      for update skip locked
    `)) as unknown as Array<{ id: string }>;
    const recovered: AgentRun[] = [];
    for (const stale of staleRows) {
      const [row] = await tx
        .update(agentRuns)
        .set({
          status: "failed",
          failedAt: new Date(input.recoveredAt),
          updatedAt: new Date(input.recoveredAt),
          lastSequence: drizzleSql<number>`${agentRuns.lastSequence} + 1`,
          error: input.error,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null
        })
        .where(
          and(
            eq(agentRuns.clientInstanceId, input.clientInstanceId),
            eq(agentRuns.id, stale.id),
            drizzleSql`${agentRuns.status} in ('running', 'waiting_for_permission', 'cancelling')`
          )
        )
        .returning();
      if (!row) continue;
      const event = {
        type: "run_failed" as const,
        runId: asAgentRunId(row.id),
        sequence: row.lastSequence,
        createdAt: input.recoveredAt,
        error: input.error
      };
      await tx.insert(agentRunObservations).values({
        clientInstanceId: row.clientInstanceId,
        runId: row.id,
        conversationId: row.conversationId,
        ownerUserId: row.ownerUserId,
        sequence: event.sequence,
        type: event.type,
        payload: event,
        createdAt: new Date(input.recoveredAt)
      });
      recovered.push(mapAgentRun(row));
    }
    return recovered;
  });
}

export async function appendRunObservation(
  db: PostgresDatabase,
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
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

function staleActiveRunWhere(input: RecoverStaleAgentRunInput) {
  return and(
    eq(agentRuns.clientInstanceId, input.clientInstanceId),
    eq(agentRuns.id, input.runId),
    drizzleSql`${agentRuns.status} in ('queued', 'running', 'waiting_for_permission', 'cancelling')`,
    lt(agentRuns.updatedAt, new Date(input.staleUpdatedBefore))
  );
}

function activeLeaseWhere(input: {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  leaseToken: string;
}) {
  return and(
    eq(agentRuns.clientInstanceId, input.clientInstanceId),
    eq(agentRuns.id, input.runId),
    eq(agentRuns.leaseToken, input.leaseToken),
    gt(agentRuns.leaseExpiresAt, drizzleSql`now()`),
    drizzleSql`${agentRuns.status} in ('running', 'waiting_for_permission', 'cancelling')`
  );
}

function terminalStatusPatch(event: AgentRuntimeEvent): Partial<typeof agentRuns.$inferInsert> {
  const terminal = {
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null
  };
  if (event.type === "run_completed") {
    return { ...terminal, status: "completed", completedAt: new Date(event.createdAt) };
  }
  if (event.type === "run_cancelled") {
    return {
      ...terminal,
      status: "cancelled",
      cancelledAt: new Date(event.createdAt),
      cancellationReason: event.reason
    };
  }
  if (event.type === "run_failed") {
    return {
      ...terminal,
      status: "failed",
      failedAt: new Date(event.createdAt),
      error: event.error
    };
  }
  return {};
}

function terminalRunPatchFromObservation(
  observation: RunObservation
): Partial<typeof agentRuns.$inferInsert> {
  const event = observation.payload;
  if (event.type === "run_completed") {
    return {
      status: "completed",
      updatedAt: new Date(event.createdAt),
      completedAt: new Date(event.createdAt),
      lastSequence: event.sequence
    };
  }
  if (event.type === "run_cancelled") {
    return {
      status: "cancelled",
      updatedAt: new Date(event.createdAt),
      cancelledAt: new Date(event.createdAt),
      lastSequence: event.sequence
    };
  }
  if (event.type !== "run_failed") {
    throw new AppError("INTERNAL", "Expected terminal run observation");
  }
  return {
    status: "failed",
    updatedAt: new Date(event.createdAt),
    failedAt: new Date(event.createdAt),
    lastSequence: event.sequence,
    error: event.error
  };
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
