import { wakeWorkflowAgentStep } from "./postgres-workflow-agent-wake";
import { lockAgentRunConversations } from "./postgres-agent-run-locks";
import { lockParentRunsOf, settleEndedAgentRuns } from "./postgres-agent-run-lineage";
import {
  dispatchConversationFollowUpJob,
  ACTIVE_AGENT_RUN_STATUSES,
  AppError,
  JobLeaseLostError,
  asAgentRunId,
  asConversationId,
  asUserId,
  createPlatformId,
  subjectRowLeaseOwnerId,
  type AgentRun,
  type AgentRunError,
  type AgentRunJobClaim,
  type AgentRunJobLease,
  type AgentRunResumeState,
  type AgentRunStore,
  type AgentRunWithoutJob,
  type AgentRunWriteFence,
  type AgentRuntimeEvent,
  type AppendClaimedAgentRunEndInput,
  type AppendClaimedAgentRunMessageInput,
  type AppendClaimedRunObservationInput,
  type AssertClaimedAgentRunInput,
  type ClaimAgentRunForJobInput,
  type ClientInstanceId,
  type FailLostAgentRunInput,
  type RenewAgentRunJobLeaseInput,
  type RunObservation,
  type SteeredUserMessage,
  type TakeClaimedAgentRunSteersInput,
  createUserMessageMetadata
} from "@work-shape/catalyst-core";
import { and, asc, sql as drizzleSql, eq, gt, inArray, lt, or, type SQL } from "drizzle-orm";
import { enqueueJob } from "./jobs/store";
import { resumeAgentRunAfterApproval } from "./postgres-agent-run-approval-resume";
import { requireActiveConversationLock } from "./postgres-conversation-operations";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { withdrawUnclaimedWorkspaceCommandsOfRuns } from "./postgres-execution-workspace-operations";
import { mapAgentRun, mapMessage, mapRunObservation } from "./rows";
import { appendAuditEvent } from "./postgres-audit-usage-operations";
import { mapFollowUp } from "./postgres-follow-up-operations";
import {
  agentRunObservations,
  agentRuns,
  conversationFollowUps,
  conversations,
  messages,
  modelProviderContinuations,
  platformJobs
} from "./schema";

/**
 * A run a worker holds. A run that waits for a decision holds no worker and no lease: it is
 * queued again when it is decided.
 */
const STARTED_STATUSES: AgentRun["status"][] = ["running", "cancelling"];

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
  if (claimed) {
    return {
      status: "claimed",
      row: mapAgentRun(claimed),
      ...(claimed.resumeState ? { resumeState: claimed.resumeState } : {})
    };
  }
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

export async function appendClaimedRunObservation(
  db: PostgresConnection,
  input: AppendClaimedRunObservationInput
): Promise<RunObservation> {
  return db.transaction(async (tx) => {
    await requireJobLease(tx, input.lease);
    if (endsRun(input.event)) await lockParentRunsOf(tx, input.clientInstanceId, [input.runId]);
    await lockClaimedRunConversation(tx, input);
    return insertClaimedRunObservation(tx, input, input.event);
  });
}

/**
 * The end of a run in one transaction: its last assistant message, when one is given, and
 * its events through the one that ends it. All of it is stored or none of it, so a run never
 * shows a stored answer beside a run that did not end. A run that pauses for a decision ends
 * its execution the same way, and keeps its resume state in the same transaction.
 */
export async function appendClaimedAgentRunEnd(
  db: PostgresConnection,
  input: AppendClaimedAgentRunEndInput
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireJobLease(tx, input.lease);
    if (input.events.some(endsRun))
      await lockParentRunsOf(tx, input.clientInstanceId, [input.runId]);
    await lockClaimedRunConversation(tx, input);
    if (input.message) await insertClaimedAgentRunMessage(tx, input, input.message);
    let sequence: number | undefined;
    if (input.allocateSequence) {
      const [run] = await tx
        .select({ lastSequence: agentRuns.lastSequence })
        .from(agentRuns)
        .where(claimedRunWhere(input))
        .for("update")
        .limit(1);
      if (!run) throw new AppError("CONFLICT", "Agent run has ended");
      sequence = run.lastSequence;
    }
    for (const event of input.events) {
      const persisted = sequence === undefined ? event : { ...event, sequence: ++sequence };
      await insertClaimedRunObservation(tx, input, persisted, input.resumeState);
    }
  });
}

async function insertClaimedRunObservation(
  tx: PostgresConnection,
  claim: ClaimedRun,
  event: AgentRuntimeEvent,
  resumeState?: AgentRunResumeState
): Promise<RunObservation> {
  if (event.runId !== claim.runId) {
    throw new AppError("VALIDATION_FAILED", "Run observation belongs to another agent run");
  }
  if (event.type === "tool_decision_requested" && !resumeState) {
    throw new AppError(
      "VALIDATION_FAILED",
      "A run waits for a decision only with its resume state"
    );
  }
  const terminal = terminalStatusPatch(event, resumeState);
  const [run] = await tx
    .update(agentRuns)
    .set({
      lastSequence: event.sequence,
      updatedAt: new Date(event.createdAt),
      ...terminal
    })
    .where(
      and(
        claimedRunWhere(claim),
        eq(agentRuns.lastSequence, event.sequence - 1),
        // A run that was asked to cancel ends as cancelled and as nothing else. What it
        // still writes on its way there is stored.
        endsOrSuspendsRun(event) ? eq(agentRuns.status, "running") : undefined
      )
    )
    .returning();
  if (!run) {
    throw new AppError(
      "CONFLICT",
      "Agent run has ended, was asked to cancel, or its sequence is stale"
    );
  }
  if (terminal.status && terminal.status !== "waiting_for_decision") {
    await withdrawUnclaimedWorkspaceCommandsOfRuns(tx, {
      clientInstanceId: claim.clientInstanceId,
      runIds: [claim.runId]
    });
    await settleEndedAgentRuns(tx, claim.clientInstanceId, [run], new Date(event.createdAt));
  }

  // A steer the run did not take in before it ended becomes a queued follow-up: never lost.
  if (
    terminal.status &&
    terminal.status !== "waiting_for_decision" &&
    run.parentRunId === null &&
    run.workflowStepRunId === null
  )
    await tx
      .update(conversationFollowUps)
      .set({ mode: "queue", dispatchedRunId: null, updatedAt: new Date(event.createdAt) })
      .where(
        and(
          eq(conversationFollowUps.clientInstanceId, claim.clientInstanceId),
          eq(conversationFollowUps.conversationId, run.conversationId),
          eq(conversationFollowUps.dispatchedRunId, run.id),
          eq(conversationFollowUps.status, "pending"),
          eq(conversationFollowUps.mode, "steer")
        )
      );

  // A subagent's thread takes no follow-ups: it has no composer.
  if (
    event.type === "run_completed" &&
    run.parentRunId === null &&
    run.workflowStepRunId === null
  ) {
    await enqueueJob(
      tx,
      dispatchConversationFollowUpJob,
      { conversationId: run.conversationId, afterRunId: run.id },
      {
        clientInstanceId: claim.clientInstanceId,
        subject: run.conversationId,
        dedupeKey: run.conversationId,
        concurrencyKey: run.conversationId,
        correlationId: run.correlationId
      }
    );
  }
  const [row] = await tx
    .insert(agentRunObservations)
    .values({
      clientInstanceId: run.clientInstanceId,
      runId: run.id,
      conversationId: run.conversationId,
      ownerUserId: run.ownerUserId,
      sequence: event.sequence,
      type: event.type,
      payload: event,
      createdAt: new Date(event.createdAt)
    })
    .returning();
  // A decision may finish before the worker stored its wait: an approval, or a confirmation
  // that waits in the Inbox (OP-4b). One in the conversation is decided only once it is
  // stored, and the resume leaves a run that waits on one alone.
  if (event.type === "tool_decision_requested") {
    await wakeWorkflowAgentStep(tx, run);
    await resumeAgentRunAfterApproval(tx, {
      clientInstanceId: claim.clientInstanceId,
      agentRunId: claim.runId
    });
  }
  return mapRunObservation(row);
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

const RUN_IN_PROGRESS_STATUSES: AgentRun["status"][] = [...ACTIVE_AGENT_RUN_STATUSES];

export async function listAgentRunsInProgress(
  db: PostgresConnection,
  input: Parameters<AgentRunStore["listAgentRunsInProgress"]>[0]
): Promise<AgentRun[]> {
  const ofInstance = eq(conversations.clientInstanceId, input.clientInstanceId);
  const subject =
    "ownerUserId" in input
      ? eq(agentRuns.ownerUserId, input.ownerUserId)
      : inArray(
          agentRuns.conversationId,
          db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              "rootConversationId" in input
                ? and(
                    ofInstance,
                    or(
                      eq(conversations.id, input.rootConversationId),
                      eq(conversations.parentConversationId, input.rootConversationId)
                    )
                  )
                : and(
                    ofInstance,
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
    )
    .orderBy(asc(agentRuns.depth), asc(agentRuns.id));
  return rows.map(mapAgentRun);
}

export async function appendClaimedAgentRunMessage(
  db: PostgresConnection,
  input: AppendClaimedAgentRunMessageInput
) {
  return db.transaction(async (tx) => {
    await requireJobLease(tx, input.lease);
    await lockClaimedRunConversation(tx, input);
    return insertClaimedAgentRunMessage(tx, input, input.message);
  });
}

/**
 * The steers sent into this run, taken in at a step boundary (FU-2). Each becomes a user row
 * stored now, so the transcript's order is the order the model read; its attachments move to
 * the row, the follow-up ends `consumed`, and every tab is told with `follow_up_changed` and
 * `user_message_steered`. The audit names the person and the run, never the text.
 */
export async function takeClaimedAgentRunSteers(
  db: PostgresConnection,
  input: TakeClaimedAgentRunSteersInput
): Promise<SteeredUserMessage[]> {
  return db.transaction(async (tx) => {
    await requireJobLease(tx, input.lease);
    await lockClaimedRunConversation(tx, input);
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(claimedRunWhere(input))
      .limit(1)
      .for("update");
    if (!run) throw new AppError("CONFLICT", "Agent run has ended");
    if (run.ownerUserId === null) return [];
    const steers = await tx
      .select()
      .from(conversationFollowUps)
      .where(
        and(
          eq(conversationFollowUps.clientInstanceId, input.clientInstanceId),
          eq(conversationFollowUps.conversationId, run.conversationId),
          eq(conversationFollowUps.dispatchedRunId, run.id),
          eq(conversationFollowUps.status, "pending"),
          eq(conversationFollowUps.mode, "steer"),
          eq(conversationFollowUps.authorUserId, run.ownerUserId)
        )
      )
      .orderBy(asc(conversationFollowUps.position));
    if (steers.length === 0) return [];
    await requireActiveConversationLock(
      tx,
      input.clientInstanceId,
      asConversationId(run.conversationId),
      asUserId(run.ownerUserId)
    );
    const takenAt = new Date();
    let sequence = run.lastSequence;
    const taken: SteeredUserMessage[] = [];
    for (const steer of steers) {
      const [row] = await tx
        .insert(messages)
        .values({
          id: createPlatformId<"MessageId">("msg"),
          clientInstanceId: input.clientInstanceId,
          conversationId: run.conversationId,
          role: "user",
          text: steer.text,
          metadata:
            createUserMessageMetadata({
              steered: {
                runId: run.id,
                followUpId: steer.id,
                authorUserId: steer.authorUserId,
                typedAt: steer.createdAt.toISOString()
              }
            }) ?? {},
          createdAt: takenAt
        })
        .returning();
      if (!row) throw new AppError("INTERNAL", "Steered message was not stored");
      const [consumed] = await tx
        .update(conversationFollowUps)
        .set({ status: "consumed", updatedAt: takenAt })
        .where(eq(conversationFollowUps.id, steer.id))
        .returning();
      if (!consumed) throw new AppError("INTERNAL", "Steered follow-up was not consumed");
      const message = mapMessage(row);
      const at = takenAt.toISOString();
      await insertClaimedRunObservation(tx, input, {
        type: "follow_up_changed",
        runId: asAgentRunId(run.id),
        sequence: ++sequence,
        createdAt: at,
        followUp: mapFollowUp(consumed)
      });
      await insertClaimedRunObservation(tx, input, {
        type: "user_message_steered",
        runId: asAgentRunId(run.id),
        sequence: ++sequence,
        createdAt: at,
        followUpId: steer.id,
        message: {
          id: message.id,
          role: "user",
          text: message.text,
          createdAt: message.createdAt,
          ...(message.metadata ? { metadata: message.metadata } : {})
        }
      });
      await appendAuditEvent(tx, {
        clientInstanceId: input.clientInstanceId,
        type: "message.created",
        status: "success",
        actor: input.actor,
        subject: message.id,
        correlationId: input.correlationId,
        metadata: {
          conversationId: run.conversationId,
          attachmentCount: 0,
          delivery: "steered",
          runId: run.id
        }
      });
      taken.push({ followUpId: steer.id, message });
    }
    await tx
      .update(conversations)
      .set({ updatedAt: takenAt })
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.id, run.conversationId),
          eq(conversations.status, "active")
        )
      );
    return taken;
  });
}

/**
 * Queue changes lock conversation -> run. Worker writes must do the same, including
 * observations: their conversation foreign key takes a key-share lock at insertion.
 * Lock only the conversation in this join; the fenced write rechecks the run afterwards.
 * Inactive conversations still admit terminal observations so deletion can end a run.
 */
async function lockClaimedRunConversation(
  tx: PostgresConnection,
  claim: ClaimedRun
): Promise<void> {
  const [conversation] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(
      agentRuns,
      and(
        eq(agentRuns.clientInstanceId, conversations.clientInstanceId),
        eq(agentRuns.conversationId, conversations.id)
      )
    )
    .where(claimedRunWhere(claim))
    .for("update", { of: conversations })
    .limit(1);
  if (!conversation) throw new AppError("CONFLICT", "Agent run has ended");
}

async function insertClaimedAgentRunMessage(
  tx: PostgresTransaction,
  claim: ClaimedRun,
  message: AppendClaimedAgentRunMessageInput["message"]
) {
  const [run] = await tx
    .select()
    .from(agentRuns)
    .where(claimedRunWhere(claim))
    .limit(1)
    .for("update");
  if (!run) throw new AppError("CONFLICT", "Agent run has ended");
  if (message.conversationId !== run.conversationId) {
    throw new AppError("CONFLICT", "Agent run message belongs to another conversation");
  }
  await requireActiveConversationLock(
    tx,
    claim.clientInstanceId,
    asConversationId(run.conversationId),
    run.ownerUserId === null ? undefined : asUserId(run.ownerUserId)
  );
  const createdAt = new Date();
  const [row] = await tx
    .insert(messages)
    .values({
      id: message.id ?? createPlatformId<"MessageId">("msg"),
      clientInstanceId: claim.clientInstanceId,
      conversationId: run.conversationId,
      role: message.role,
      text: message.text,
      metadata: message.metadata ?? {},
      createdAt
    })
    .returning();
  if (!row) throw new AppError("INTERNAL", "Agent run message was not persisted");
  await tx
    .update(conversations)
    .set({ updatedAt: createdAt })
    .where(
      and(
        eq(conversations.clientInstanceId, claim.clientInstanceId),
        eq(conversations.id, run.conversationId),
        eq(conversations.status, "active")
      )
    );
  if (message.role === "assistant" && message.providerContinuation) {
    const continuation = message.providerContinuation;
    await tx
      .insert(modelProviderContinuations)
      .values({
        clientInstanceId: claim.clientInstanceId,
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
}

export async function failLostAgentRun(
  db: PostgresConnection,
  input: FailLostAgentRunInput
): Promise<AgentRun | undefined> {
  return db.transaction(async (tx) => {
    await lockParentRunsOf(tx, input.clientInstanceId, [input.runId]);
    await lockAgentRunConversations(tx, input.clientInstanceId, [input.runId]);
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
        heartbeatAt: null,
        resumeState: null
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
    await withdrawUnclaimedWorkspaceCommandsOfRuns(tx, {
      clientInstanceId: input.clientInstanceId,
      runIds: [input.runId]
    });
    await settleEndedAgentRuns(tx, input.clientInstanceId, [row], row.failedAt);
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
  return failAgentRunsWhere(db, input, () =>
    and(
      eq(agentRuns.status, "queued"),
      // `updated_at` is when the run was accepted, or queued again after a decision; a queued
      // run has not been claimed since.
      lt(
        agentRuns.updatedAt,
        drizzleSql`now() - make_interval(secs => ${input.queuedMs}::double precision / 1000)`
      )
    )
  );
}

export async function failAgentRunsWithoutWorker(
  db: PostgresConnection,
  input: Parameters<AgentRunStore["failAgentRunsWithoutWorker"]>[0]
): Promise<AgentRun[]> {
  return failAgentRunsWhere(db, input, () =>
    and(
      inArray(agentRuns.status, STARTED_STATUSES),
      drizzleSql`(${agentRuns.leaseExpiresAt} is null or ${agentRuns.leaseExpiresAt} <= now())`,
      // A running job is its worker's while its lease lasts, and the burial of the job ends
      // the run after that.
      drizzleSql`not exists (
        select 1 from platform_jobs job
        where job.client_instance_id = ${agentRuns.clientInstanceId}
          and job.kind = ${input.jobKind}
          and job.dedupe_key = ${input.jobKind} || ':' || ${agentRuns.id}
          and job.status = 'running'
      )`
    )
  );
}

/** Fails up to `limit` runs that meet `condition`, oldest first, each with a `run_failed` event. */
async function failAgentRunsWhere(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; error: AgentRunError; limit: number },
  condition: () => SQL | undefined
): Promise<AgentRun[]> {
  return db.transaction(async (tx) => {
    const ofInstance = eq(agentRuns.clientInstanceId, input.clientInstanceId);
    const chosen = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(ofInstance, condition()))
      .orderBy(asc(agentRuns.startedAt), asc(agentRuns.id))
      .limit(input.limit);
    if (!chosen.length) return [];
    const runIds = chosen.map((run) => run.id);
    await lockParentRunsOf(tx, input.clientInstanceId, runIds);
    await lockAgentRunConversations(tx, input.clientInstanceId, runIds);
    const rows = await tx
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
        heartbeatAt: null,
        resumeState: null
      })
      // The condition is read again under the row lock: a run that a worker claimed, renewed
      // or ended meanwhile stays as it is.
      .where(and(ofInstance, condition(), inArray(agentRuns.id, runIds)))
      .returning();
    const failed = rows.flatMap((row) => (row.failedAt ? [{ row, failedAt: row.failedAt }] : []));
    if (failed.length === 0) return [];
    await withdrawUnclaimedWorkspaceCommandsOfRuns(tx, {
      clientInstanceId: input.clientInstanceId,
      runIds: failed.map(({ row }) => asAgentRunId(row.id))
    });
    await settleEndedAgentRuns(
      tx,
      input.clientInstanceId,
      failed.map(({ row }) => row),
      failed[0]?.failedAt ?? new Date()
    );
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
        // Only a run that was never started is executed. A started run that lost its worker
        // is failed by `failAgentRunsWithoutWorker`.
        eq(agentRuns.status, "queued"),
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
export async function requireJobLease(
  tx: PostgresConnection,
  lease: AgentRunJobLease
): Promise<void> {
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

/**
 * The fence of a write that a run makes outside its events and messages: the job still runs
 * under the lease and the run has not ended. Both hold until `tx` ends.
 */
export async function requireClaimedAgentRun(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  fence: AgentRunWriteFence
): Promise<void> {
  await requireJobLease(tx, fence.lease);
  const [row] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(claimedRunWhere({ clientInstanceId, ...fence }))
    .limit(1)
    .for("share");
  if (!row) throw new AppError("CONFLICT", "Agent run has ended");
}

/** One run as the attempt of a job holds it. */
export interface ClaimedRun {
  clientInstanceId: ClientInstanceId;
  runId: AgentRun["id"];
  lease: AgentRunJobLease;
}

/** The run is this attempt's and has not ended. A cancelling run still takes its last writes. */
export function claimedRunWhere(input: ClaimedRun) {
  return and(
    eq(agentRuns.clientInstanceId, input.clientInstanceId),
    eq(agentRuns.id, input.runId),
    eq(agentRuns.leaseToken, input.lease.leaseToken),
    inArray(agentRuns.status, STARTED_STATUSES)
  );
}

/** An event after which the run has ended. */
function endsRun(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled"
  );
}

function endsOrSuspendsRun(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "run_completed" ||
    event.type === "run_failed" ||
    event.type === "tool_decision_requested"
  );
}

function leaseExpiry(leaseMs: number) {
  return drizzleSql<Date>`now() + make_interval(secs => ${leaseMs}::double precision / 1000)`;
}

/**
 * What an event that ends a run's execution sets: the run lets go of its worker. A run that
 * ended keeps no resume state; one that waits for a decision keeps the one it was given.
 */
function terminalStatusPatch(
  event: AgentRuntimeEvent,
  resumeState: AgentRunResumeState | undefined
): Partial<typeof agentRuns.$inferInsert> {
  const released = {
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null
  };
  const terminal = { ...released, resumeState: null };
  if (event.type === "tool_decision_requested") {
    return { ...released, status: "waiting_for_decision", resumeState };
  }
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
