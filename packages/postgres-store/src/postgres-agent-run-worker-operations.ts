import { and, eq, gt, inArray, isNotNull, lt, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  type AgentRun,
  type AgentRunId,
  type AgentRunStore,
  type AgentRuntimeEvent,
  type AppendClaimedAgentRunMessageInput,
  type AppendClaimedRunObservationInput,
  type AssertClaimedAgentRunInput,
  type ClaimAgentRunInput,
  type ClientInstanceId,
  type HeartbeatAgentRunInput,
  type RecoverExpiredAgentRunsInput,
  type RequestAgentRunCancellationInput,
  type RunObservation,
  asAgentRunId,
  asConversationId,
  createPlatformId
} from "@vivd-catalyst/core";
import { requireActiveConversationLock } from "./postgres-conversation-operations";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { mapAgentRun, mapMessage, mapRunObservation } from "./rows";
import {
  agentRunObservations,
  agentRuns,
  collaborationWorkspaces,
  conversations,
  messages,
  modelProviderContinuations,
  productUsers
} from "./schema";

export async function claimNextAgentRun(
  db: PostgresConnection,
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
  db: PostgresConnection,
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
  db: PostgresConnection,
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
  db: PostgresConnection,
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
      .where(and(eventLeaseWhere(input), eq(agentRuns.lastSequence, input.event.sequence - 1)))
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

export async function assertClaimedAgentRun(
  db: PostgresConnection,
  input: AssertClaimedAgentRunInput
): Promise<AgentRun> {
  const [row] = await db.select().from(agentRuns).where(effectLeaseWhere(input)).limit(1);
  if (!row) throw new AppError("CONFLICT", "Agent run lease is no longer active");
  return mapAgentRun(row);
}

const RUN_IN_PROGRESS_STATUSES: AgentRun["status"][] = [
  "queued",
  "running",
  "waiting_for_permission",
  "cancelling"
];

export async function listAgentRunsInProgress(
  db: PostgresConnection,
  input: Parameters<AgentRunStore["listAgentRunsInProgress"]>[0]
): Promise<AgentRun[]> {
  const subject =
    "ownerUserId" in input
      ? eq(agentRuns.ownerUserId, input.ownerUserId)
      : inArray(
          agentRuns.conversationId,
          db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.clientInstanceId, input.clientInstanceId),
                eq(conversations.collaborationWorkspaceId, input.collaborationWorkspaceId)
              )
            )
        );
  const rows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, input.clientInstanceId),
        inArray(agentRuns.status, RUN_IN_PROGRESS_STATUSES),
        subject
      )
    );
  return rows.map(mapAgentRun);
}

/** Whether the user who started the run, or the workspace its Conversation is in, is marked. */
async function ownerOrWorkspaceInDeletion(
  tx: PostgresTransaction,
  run: { clientInstanceId: string; conversationId: string; ownerUserId: string }
): Promise<boolean> {
  const [owner] = await tx
    .select({ id: productUsers.id })
    .from(productUsers)
    .where(
      and(
        eq(productUsers.clientInstanceId, run.clientInstanceId),
        eq(productUsers.id, run.ownerUserId),
        isNotNull(productUsers.deletionRequestedAt)
      )
    )
    .limit(1);
  if (owner) return true;
  const [workspace] = await tx
    .select({ id: collaborationWorkspaces.id })
    .from(collaborationWorkspaces)
    .innerJoin(
      conversations,
      and(
        eq(conversations.clientInstanceId, collaborationWorkspaces.clientInstanceId),
        eq(conversations.collaborationWorkspaceId, collaborationWorkspaces.id)
      )
    )
    .where(
      and(
        eq(conversations.clientInstanceId, run.clientInstanceId),
        eq(conversations.id, run.conversationId),
        isNotNull(collaborationWorkspaces.deletionRequestedAt)
      )
    )
    .limit(1);
  return workspace !== undefined;
}

export async function appendClaimedAgentRunMessage(
  db: PostgresConnection,
  input: AppendClaimedAgentRunMessageInput
) {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(effectLeaseWhere(input))
      .limit(1)
      .for("update");
    if (!run) throw new AppError("CONFLICT", "Agent run lease is no longer active");
    if (input.message.conversationId !== run.conversationId) {
      throw new AppError("CONFLICT", "Agent run message belongs to another conversation");
    }
    await requireActiveConversationLock(
      tx,
      input.clientInstanceId,
      asConversationId(run.conversationId)
    );
    if (await ownerOrWorkspaceInDeletion(tx, run)) {
      throw new AppError("CONFLICT", "Conversation no longer accepts messages");
    }
    const createdAt = new Date();
    const [row] = await tx
      .insert(messages)
      .values({
        id: input.message.id ?? createPlatformId<"MessageId">("msg"),
        clientInstanceId: input.clientInstanceId,
        conversationId: run.conversationId,
        role: input.message.role,
        text: input.message.text,
        metadata: input.message.metadata ?? {},
        createdAt
      })
      .returning();
    if (!row) throw new AppError("INTERNAL", "Agent run message was not persisted");
    await tx
      .update(conversations)
      .set({ updatedAt: createdAt })
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.id, run.conversationId),
          eq(conversations.status, "active")
        )
      );
    if (input.message.role === "assistant" && input.message.providerContinuation) {
      const continuation = input.message.providerContinuation;
      await tx
        .insert(modelProviderContinuations)
        .values({
          clientInstanceId: input.clientInstanceId,
          conversationId: run.conversationId,
          providerId: continuation.providerId,
          state: continuation.state,
          sourceMessageId: row.id,
          sourceStorageOrdinal: row.storageOrdinal,
          updatedAt: createdAt
        })
        .onConflictDoUpdate({
          target: [
            modelProviderContinuations.clientInstanceId,
            modelProviderContinuations.conversationId,
            modelProviderContinuations.providerId
          ],
          set: {
            state: continuation.state,
            sourceMessageId: row.id,
            sourceStorageOrdinal: row.storageOrdinal,
            updatedAt: createdAt
          },
          setWhere: lt(modelProviderContinuations.sourceStorageOrdinal, row.storageOrdinal)
        });
    }
    return mapMessage(row);
  });
}

export async function recoverExpiredAgentRuns(
  db: PostgresConnection,
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

function eventLeaseWhere(input: AppendClaimedRunObservationInput) {
  return and(
    activeLeaseWhere(input),
    input.event.type === "run_cancelled"
      ? drizzleSql`${agentRuns.status} in ('running', 'waiting_for_permission', 'cancelling')`
      : drizzleSql`${agentRuns.status} in ('running', 'waiting_for_permission')`
  );
}

function effectLeaseWhere(input: {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  leaseToken: string;
}) {
  return and(
    eq(agentRuns.clientInstanceId, input.clientInstanceId),
    eq(agentRuns.id, input.runId),
    eq(agentRuns.leaseToken, input.leaseToken),
    gt(agentRuns.leaseExpiresAt, drizzleSql`now()`),
    drizzleSql`${agentRuns.status} in ('running', 'waiting_for_permission')`
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
