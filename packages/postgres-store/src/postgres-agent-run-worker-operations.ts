import { and, asc, eq, gt, inArray, lt, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  JobLeaseLostError,
  type AgentRun,
  type AgentRunJobClaim,
  type AgentRunJobLease,
  type AgentRunStore,
  type AgentRunWithoutJob,
  type AgentRuntimeEvent,
  type AppendClaimedAgentRunMessageInput,
  type AppendClaimedRunObservationInput,
  type AssertClaimedAgentRunInput,
  type ClaimAgentRunForJobInput,
  type ClientInstanceId,
  type FailLostAgentRunInput,
  type RenewAgentRunJobLeaseInput,
  type RequestAgentRunCancellationInput,
  type RunObservation,
  asAgentRunId,
  asConversationId,
  asUserId,
  createPlatformId,
  subjectRowLeaseOwnerId
} from "@vivd-catalyst/core";
import { requireActiveConversationLock } from "./postgres-conversation-operations";
import type { PostgresConnection } from "./postgres-database";
import { mapAgentRun, mapMessage, mapRunObservation } from "./rows";
import {
  agentRunObservations,
  agentRuns,
  conversations,
  messages,
  modelProviderContinuations,
  platformJobs
} from "./schema";

const STARTED_STATUSES: AgentRun["status"][] = ["running", "waiting_for_permission", "cancelling"];

/**
 * A run is executed only by the attempt whose claim moves the row from queued to running here.
 * A row that is already past queued was started by someone: a worker of the previous release
 * that still holds it, or a worker that is gone.
 */
export async function claimAgentRunForJob(
  db: PostgresConnection,
  input: ClaimAgentRunForJobInput
): Promise<AgentRunJobClaim> {
  const ofRow = and(
    eq(agentRuns.clientInstanceId, input.clientInstanceId),
    eq(agentRuns.id, input.runId)
  );
  const leaseOwnerId = subjectRowLeaseOwnerId(input.lease.jobId);
  const [claimed] = await db
    .update(agentRuns)
    .set({
      status: "running",
      leaseOwner: leaseOwnerId,
      leaseToken: input.lease.leaseToken,
      leaseExpiresAt: leaseExpiry(input.leaseMs),
      heartbeatAt: drizzleSql`now()`,
      updatedAt: drizzleSql`now()`
    })
    .where(and(ofRow, eq(agentRuns.status, "queued")))
    .returning();
  if (claimed) return { status: "claimed", row: mapAgentRun(claimed) };
  const [current] = await db
    .select({
      status: agentRuns.status,
      heldByAnother: heldByAnother(leaseOwnerId)
    })
    .from(agentRuns)
    .where(ofRow)
    .limit(1);
  if (!current || !STARTED_STATUSES.includes(current.status)) return { status: "finished" };
  return current.heldByAnother ? { status: "held" } : { status: "started" };
}

export async function renewAgentRunJobLease(
  db: PostgresConnection,
  input: RenewAgentRunJobLeaseInput
): Promise<boolean> {
  const rows = await db
    .update(agentRuns)
    // `updated_at` moves too, as the heartbeat of the previous release moved it: the API of
    // that release ends a run in progress whose row stood still for half an hour.
    .set({
      leaseExpiresAt: leaseExpiry(input.leaseMs),
      heartbeatAt: drizzleSql`now()`,
      updatedAt: drizzleSql`now()`
    })
    .where(
      and(
        eq(agentRuns.clientInstanceId, input.clientInstanceId),
        eq(agentRuns.id, input.runId),
        eq(agentRuns.leaseToken, input.lease.leaseToken),
        inArray(agentRuns.status, STARTED_STATUSES)
      )
    )
    .returning({ id: agentRuns.id });
  return rows.length > 0;
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
    await requireJobLease(tx, input.lease);
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
      .where(
        and(
          claimedRunWhere(input),
          eq(agentRuns.lastSequence, input.event.sequence - 1),
          // A run that was asked to cancel ends as cancelled and as nothing else. What it
          // still writes on its way there is stored.
          endsOrSuspendsRun(input.event)
            ? inArray(agentRuns.status, ["running", "waiting_for_permission"])
            : undefined
        )
      )
      .returning();
    if (!run) {
      throw new AppError(
        "CONFLICT",
        "Agent run has ended, was asked to cancel, or its sequence is stale"
      );
    }

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
  return db.transaction(async (tx) => {
    await requireJobLease(tx, input.lease);
    const [row] = await tx.select().from(agentRuns).where(claimedRunWhere(input)).limit(1);
    if (!row) throw new AppError("CONFLICT", "Agent run has ended");
    return mapAgentRun(row);
  });
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

export async function appendClaimedAgentRunMessage(
  db: PostgresConnection,
  input: AppendClaimedAgentRunMessageInput
) {
  return db.transaction(async (tx) => {
    await requireJobLease(tx, input.lease);
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(claimedRunWhere(input))
      .limit(1)
      .for("update");
    if (!run) throw new AppError("CONFLICT", "Agent run has ended");
    if (input.message.conversationId !== run.conversationId) {
      throw new AppError("CONFLICT", "Agent run message belongs to another conversation");
    }
    await requireActiveConversationLock(
      tx,
      input.clientInstanceId,
      asConversationId(run.conversationId),
      asUserId(run.ownerUserId)
    );
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

export async function failLostAgentRun(
  db: PostgresConnection,
  input: FailLostAgentRunInput
): Promise<AgentRun | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentRuns)
      .set({
        status: "failed",
        failedAt: drizzleSql`now()`,
        updatedAt: drizzleSql`now()`,
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
          eq(agentRuns.id, input.runId),
          inArray(agentRuns.status, STARTED_STATUSES),
          // The job that is gone may never have held the run: in a rolling deploy a worker of
          // the previous release can execute it under a lease of its own. That run is alive.
          drizzleSql`not ${heldByAnother(subjectRowLeaseOwnerId(input.jobId))}`
        )
      )
      .returning();
    if (!row?.failedAt) return undefined;
    const event = {
      type: "run_failed" as const,
      runId: asAgentRunId(row.id),
      sequence: row.lastSequence,
      createdAt: row.failedAt.toISOString(),
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
      createdAt: row.failedAt
    });
    return mapAgentRun(row);
  });
}

export async function failAgentRunsQueuedTooLong(
  db: PostgresConnection,
  input: Parameters<AgentRunStore["failAgentRunsQueuedTooLong"]>[0]
): Promise<AgentRun[]> {
  return db.transaction(async (tx) => {
    const ofInstance = eq(agentRuns.clientInstanceId, input.clientInstanceId);
    const waiting = tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          ofInstance,
          eq(agentRuns.status, "queued"),
          // `started_at` is when the run was accepted; a queued run has not been claimed.
          lt(
            agentRuns.startedAt,
            drizzleSql`now() - make_interval(secs => ${input.queuedMs}::double precision / 1000)`
          )
        )
      )
      .orderBy(asc(agentRuns.startedAt), asc(agentRuns.id))
      .limit(input.limit);
    const rows = await tx
      .update(agentRuns)
      .set({
        status: "failed",
        failedAt: drizzleSql`now()`,
        updatedAt: drizzleSql`now()`,
        lastSequence: drizzleSql<number>`${agentRuns.lastSequence} + 1`,
        error: input.error
      })
      // The status is read again under the row lock: a run a worker claimed meanwhile stays.
      .where(and(ofInstance, eq(agentRuns.status, "queued"), inArray(agentRuns.id, waiting)))
      .returning();
    const failed = rows.flatMap((row) => (row.failedAt ? [{ row, failedAt: row.failedAt }] : []));
    if (failed.length === 0) return [];
    await tx.insert(agentRunObservations).values(
      failed.map(({ row, failedAt }) => ({
        clientInstanceId: row.clientInstanceId,
        runId: row.id,
        conversationId: row.conversationId,
        ownerUserId: row.ownerUserId,
        sequence: row.lastSequence,
        type: "run_failed" as const,
        payload: {
          type: "run_failed" as const,
          runId: asAgentRunId(row.id),
          sequence: row.lastSequence,
          createdAt: failedAt.toISOString(),
          error: input.error
        },
        createdAt: failedAt
      }))
    );
    return failed.map(({ row }) => mapAgentRun(row));
  });
}

export async function listAgentRunsWithoutJob(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; jobKind: string; limit: number }
): Promise<AgentRunWithoutJob[]> {
  const rows = await db
    .select({ id: agentRuns.id, correlationId: agentRuns.correlationId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, input.clientInstanceId),
        inArray(agentRuns.status, RUN_IN_PROGRESS_STATUSES),
        // A run under a live lease is someone's: a job of it would only find it held.
        drizzleSql`(${agentRuns.leaseExpiresAt} is null or ${agentRuns.leaseExpiresAt} <= now())`,
        drizzleSql`not exists (
          select 1 from platform_jobs job
          where job.client_instance_id = ${agentRuns.clientInstanceId}
            and job.kind = ${input.jobKind}
            and job.dedupe_key = ${input.jobKind} || ':' || ${agentRuns.id}
            and job.status in ('queued', 'running')
        )`
      )
    )
    .orderBy(asc(agentRuns.startedAt), asc(agentRuns.id))
    .limit(input.limit);
  return rows.map((row) => ({ id: asAgentRunId(row.id), correlationId: row.correlationId }));
}

/**
 * The fence of every write of a run. The job row is read under a share lock, so the executor
 * cannot bury or release the job before this transaction ends: what the transaction stores
 * was stored while the lease was this attempt's.
 */
async function requireJobLease(tx: PostgresConnection, lease: AgentRunJobLease): Promise<void> {
  const [held] = await tx
    .select({ id: platformJobs.id })
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.id, lease.jobId),
        eq(platformJobs.leaseToken, lease.leaseToken),
        eq(platformJobs.status, "running"),
        gt(platformJobs.leaseExpiresAt, drizzleSql`clock_timestamp()`)
      )
    )
    .for("share");
  if (!held) throw new JobLeaseLostError(lease.jobId);
}

/** Someone other than `leaseOwnerId` holds the run under a lease that has not run out. */
function heldByAnother(leaseOwnerId: string) {
  return drizzleSql<boolean>`(
    ${agentRuns.leaseExpiresAt} is not null
    and ${agentRuns.leaseExpiresAt} > now()
    and ${agentRuns.leaseOwner} is distinct from ${leaseOwnerId}
  )`;
}

/** The run is this attempt's and has not ended. A cancelling run still takes its last writes. */
function claimedRunWhere(input: {
  clientInstanceId: ClientInstanceId;
  runId: AgentRun["id"];
  lease: AgentRunJobLease;
}) {
  return and(
    eq(agentRuns.clientInstanceId, input.clientInstanceId),
    eq(agentRuns.id, input.runId),
    eq(agentRuns.leaseToken, input.lease.leaseToken),
    inArray(agentRuns.status, STARTED_STATUSES)
  );
}

function endsOrSuspendsRun(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "run_completed" ||
    event.type === "run_failed" ||
    event.type === "tool_permission_requested"
  );
}

function leaseExpiry(leaseMs: number) {
  return drizzleSql<Date>`now() + make_interval(secs => ${leaseMs}::double precision / 1000)`;
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
