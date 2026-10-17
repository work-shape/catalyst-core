import { lockAgentRunConversations } from "./postgres-agent-run-locks";
import { expireOperationRunsAndResumeAgents } from "./postgres-operation-run-expiry";
import {
  INTERRUPTED_RUN_ERROR,
  WAITING_OPERATION_RUN_STATUSES,
  type OperationRun,
  type OperationRunStatus,
  type OperationRunStore
} from "@work-shape/catalyst-core";
import { and, asc, desc, eq, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { resumeAgentRunAfterApproval } from "./postgres-agent-run-approval-resume";
import { wakeStepsWaitingFor } from "./postgres-workflow-operation-wake";
import { keysetFilter } from "./paging";
import { type PostgresConnection } from "./postgres-database";
import { conversations } from "./schema/conversations";
import { operationRuns } from "./schema/operationRuns";
import { agentRuns } from "./schema/agentRuns";

const OPEN_RUN_STATUSES = [
  "running",
  "pending_confirmation",
  "pending_approval"
] as const satisfies readonly OperationRunStatus[];

type OperationRunRow = typeof operationRuns.$inferSelect;
type Input<Method extends keyof OperationRunStore> = Parameters<OperationRunStore[Method]>[0];

async function createOperationRun(
  db: PostgresConnection,
  run: Input<"create">
): Promise<OperationRun | undefined> {
  const startedAt = new Date(run.startedAt);
  const [row] = await db
    .insert(operationRuns)
    .values({
      id: run.id,
      clientInstanceId: run.clientInstanceId,
      operation: run.operation,
      effect: run.effect,
      actorKind: run.actor.kind,
      actorId: run.actor.id,
      actor: run.actor,
      ownerUserId: run.ownerUserId,
      collaborationWorkspaceId: run.workspaceId ?? conversationWorkspace(run),
      originKind: run.origin.kind,
      origin: run.origin,
      target: run.target,
      conversationId: run.conversationId,
      idempotencyKey: run.idempotencyKey,
      inputHash: run.inputHash,
      status: "running",
      correlationId: run.correlationId,
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt
    })
    // The key is taken. A failed run of the same call is handed out again, as its next attempt,
    // only where it is a read, failed before its implementation started, or was interrupted
    // and its operation is one that is called again under its key. Every other holder
    // of the key leaves this statement without a row: a changing call that failed or was
    // interrupted may have changed something, and running it again would repeat it.
    .onConflictDoUpdate({
      target: [
        operationRuns.clientInstanceId,
        operationRuns.actorKind,
        operationRuns.actorId,
        operationRuns.idempotencyKey
      ],
      targetWhere: sql`${operationRuns.idempotencyKey} is not null`,
      set: {
        status: "running",
        attempt: sql`${operationRuns.attempt} + 1`,
        error: null,
        correlationId: run.correlationId,
        startedAt,
        finishedAt: null,
        updatedAt: startedAt
      },
      setWhere: and(
        eq(operationRuns.status, "failed"),
        eq(operationRuns.operation, run.operation),
        eq(operationRuns.inputHash, run.inputHash),
        or(
          eq(operationRuns.effect, "reading"),
          sql`${operationRuns.error}->>'unexecuted' = 'true'`,
          // An operation that is called again under the key of a call that was cut off.
          run.takesInterrupted
            ? sql`${operationRuns.error}->>'code' = ${INTERRUPTED_RUN_ERROR.code}`
            : undefined
        )
      )
    })
    .returning();
  return row ? mapOperationRun(row) : undefined;
}

async function recordEndedOperationRun(
  db: PostgresConnection,
  run: Input<"recordEnded">
): Promise<OperationRun> {
  const { end } = run;
  const startedAt = new Date(run.startedAt);
  const finishedAt = new Date(end.finishedAt);
  const [row] = await db
    .insert(operationRuns)
    .values({
      id: run.id,
      clientInstanceId: run.clientInstanceId,
      operation: run.operation,
      effect: run.effect,
      actorKind: run.actor.kind,
      actorId: run.actor.id,
      actor: run.actor,
      ownerUserId: run.ownerUserId,
      collaborationWorkspaceId: run.workspaceId ?? conversationWorkspace(run),
      originKind: run.origin.kind,
      origin: run.origin,
      target: run.target,
      conversationId: run.conversationId,
      inputHash: run.inputHash,
      status: end.status,
      error: end.status === "denied" ? { ...end.error, denial: end.denial } : end.error,
      correlationId: run.correlationId,
      createdAt: startedAt,
      startedAt,
      finishedAt,
      updatedAt: finishedAt
    })
    .returning();
  if (!row) {
    throw new Error(`Operation run '${run.id}' was not written`);
  }
  return mapOperationRun(row);
}

/** A call a conversation caused happens in that conversation's workspace. */
function conversationWorkspace(run: Pick<Input<"create">, "clientInstanceId" | "conversationId">) {
  return run.conversationId === undefined
    ? undefined
    : sql`(select ${conversations.collaborationWorkspaceId} from ${conversations}
        where ${conversations.clientInstanceId} = ${run.clientInstanceId}
          and ${conversations.id} = ${run.conversationId})`;
}

async function finishOperationRun(
  db: PostgresConnection,
  input: Input<"finish">
): Promise<OperationRun | undefined> {
  const { end } = input;
  const finishedAt = new Date(end.finishedAt);
  const [row] = await db
    .update(operationRuns)
    .set({
      status: end.status,
      updatedAt: finishedAt,
      ...(end.status === "pending_approval"
        ? {
            approvalRequestId: end.approvalRequestId,
            inputRef: end.inputRef,
            expiresAt: new Date(end.expiresAt)
          }
        : end.status === "pending_confirmation"
          ? {
              inputRef: end.inputRef,
              expiresAt: new Date(end.expiresAt),
              // A confirmation that waits in its person's Inbox names its item.
              ...(end.approvalRequestId ? { approvalRequestId: end.approvalRequestId } : {})
            }
          : { finishedAt }),
      ...(end.status === "done"
        ? {
            output: end.output,
            resultRef: end.resultRef,
            // A run that was approved keeps the decision it was taken with.
            ...(end.decision ? { decision: end.decision } : {}),
            usage: end.usage
          }
        : {}),
      ...(end.status === "failed" ? { error: end.error } : {}),
      ...(end.status === "denied" ? { error: { ...end.error, denial: end.denial } } : {})
    })
    .where(
      and(
        identity(input),
        eq(operationRuns.status, "running"),
        // The writer of an attempt that a later call took over ends nothing.
        input.attempt === undefined ? undefined : eq(operationRuns.attempt, input.attempt)
      )
    )
    .returning();
  return row ? mapOperationRun(row) : undefined;
}

async function findOperationRunByIdempotencyKey(
  db: PostgresConnection,
  input: Input<"findByIdempotencyKey">
): Promise<OperationRun | undefined> {
  const [row] = await db
    .select()
    .from(operationRuns)
    .where(
      and(
        eq(operationRuns.clientInstanceId, input.clientInstanceId),
        eq(operationRuns.actorKind, input.actor.kind),
        eq(operationRuns.actorId, input.actor.id),
        eq(operationRuns.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  return row ? mapOperationRun(row) : undefined;
}

async function getOperationRun(
  db: PostgresConnection,
  input: Input<"get">
): Promise<OperationRun | undefined> {
  const [row] = await db.select().from(operationRuns).where(identity(input)).limit(1);
  return row ? mapOperationRun(row) : undefined;
}

async function listOperationRuns(
  db: PostgresConnection,
  input: Input<"list">
): Promise<OperationRun[]> {
  const { filters = {} } = input;
  const rows = await db
    .select()
    .from(operationRuns)
    .where(
      and(
        eq(operationRuns.clientInstanceId, input.clientInstanceId),
        filters.operation === undefined
          ? undefined
          : eq(operationRuns.operation, filters.operation),
        filters.effect === undefined ? undefined : eq(operationRuns.effect, filters.effect),
        filters.status === undefined ? undefined : eq(operationRuns.status, filters.status),
        filters.actorId === undefined ? undefined : eq(operationRuns.actorId, filters.actorId),
        filters.originKind === undefined
          ? undefined
          : eq(operationRuns.originKind, filters.originKind),
        filters.workspaceId === undefined
          ? undefined
          : eq(operationRuns.collaborationWorkspaceId, filters.workspaceId),
        filters.since === undefined
          ? undefined
          : gte(operationRuns.createdAt, new Date(filters.since)),
        keysetFilter(input.page, [operationRuns.createdAt, operationRuns.id], true)
      )
    )
    .orderBy(desc(operationRuns.createdAt), desc(operationRuns.id))
    .limit(input.page?.limit ?? 2147483647);
  return rows.map(mapOperationRun);
}

async function resumeOperationRun(
  db: PostgresConnection,
  input: Input<"resume">
): Promise<OperationRun | undefined> {
  const startedAt = new Date(input.startedAt);
  const [row] = await db
    .update(operationRuns)
    .set({ status: "running", decision: input.decision, startedAt, updatedAt: startedAt })
    // Only a run that still waits and whose time has not run out is taken, so an approval and
    // the expiry of the same run never both win. A confirmed call has had its decision in time
    // and waits only for the worker of its Agent Run.
    .where(
      and(
        identity(input),
        or(
          and(
            eq(operationRuns.status, "pending_approval"),
            or(
              isNull(operationRuns.expiresAt),
              sql`${operationRuns.expiresAt} > now()`,
              sql`${operationRuns.decision}->>'mode' = 'approved'`
            )
          ),
          and(
            eq(operationRuns.status, "pending_confirmation"),
            sql`${operationRuns.decision}->>'mode' = 'confirmed'`
          )
        )
      )
    )
    .returning();
  return row ? mapOperationRun(row) : undefined;
}

async function endWaitingOperationRun(
  db: PostgresConnection,
  input: Input<"endWaiting">
): Promise<OperationRun | undefined> {
  const { end } = input;
  const finishedAt = new Date(end.finishedAt);
  const [row] = await db
    .update(operationRuns)
    .set({
      status: end.status,
      finishedAt,
      updatedAt: finishedAt,
      error: end.status === "denied" ? { ...end.error, denial: end.denial } : end.error,
      ...(input.decision ? { decision: input.decision } : {})
    })
    .where(and(identity(input), inArray(operationRuns.status, WAITING_OPERATION_RUN_STATUSES)))
    .returning();
  return row ? mapOperationRun(row) : undefined;
}

async function markOperationRunsExpired(
  db: PostgresConnection,
  input: Input<"markExpired">
): Promise<OperationRun[]> {
  const rows = await expireOperationRunsAndResumeAgents(db, input);
  return rows.map(mapOperationRun);
}

async function listOperationRunsRunningSince(
  db: PostgresConnection,
  input: Input<"listRunningSince">
): Promise<OperationRun[]> {
  const rows = await db
    .select()
    .from(operationRuns)
    .where(
      and(
        eq(operationRuns.clientInstanceId, input.clientInstanceId),
        eq(operationRuns.status, "running"),
        lt(operationRuns.startedAt, new Date(input.startedBefore))
      )
    )
    .orderBy(asc(operationRuns.startedAt))
    .limit(input.limit);
  return rows.map(mapOperationRun);
}

async function deleteOperationRunsOfConversations(
  db: PostgresConnection,
  input: Input<"deleteOfConversations">
): Promise<number> {
  if (input.conversationIds.length === 0) return 0;
  const removed = await db
    .delete(operationRuns)
    .where(
      and(
        eq(operationRuns.clientInstanceId, input.clientInstanceId),
        inArray(operationRuns.conversationId, [...input.conversationIds])
      )
    );
  return removed.count;
}

async function deleteOperationRunsWithoutConversationOlderThan(
  db: PostgresConnection,
  input: Input<"deleteWithoutConversationOlderThan">
): Promise<number> {
  const old = db
    .select({ id: operationRuns.id })
    .from(operationRuns)
    .where(
      and(
        eq(operationRuns.clientInstanceId, input.clientInstanceId),
        isNull(operationRuns.conversationId),
        // A run that still runs or waits is not history yet, whatever its age.
        notInArray(operationRuns.status, [...OPEN_RUN_STATUSES]),
        // The cutoff is the database's: its clock stamped the rows.
        lt(operationRuns.createdAt, sql`now() - make_interval(days => ${input.days})`)
      )
    )
    .orderBy(asc(operationRuns.createdAt))
    .limit(input.limit);
  const removed = await db.delete(operationRuns).where(inArray(operationRuns.id, old));
  return removed.count;
}

async function markOperationRunInterrupted(
  db: PostgresConnection,
  input: Input<"markInterrupted">
): Promise<OperationRun | undefined> {
  const [row] = await db
    .update(operationRuns)
    .set({
      status: "failed",
      error: INTERRUPTED_RUN_ERROR,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`
    })
    .where(and(identity(input), eq(operationRuns.status, "running")))
    .returning();
  return row ? mapOperationRun(row) : undefined;
}

function identity(input: Pick<Input<"get">, "clientInstanceId" | "id">) {
  return and(
    eq(operationRuns.clientInstanceId, input.clientInstanceId),
    // The id may be any text a caller named, so it is compared as text, not as a known id.
    eq(operationRuns.id, sql`${input.id}`)
  );
}

export function mapOperationRun(row: OperationRunRow): OperationRun {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    operation: row.operation,
    effect: row.effect,
    actor: row.actor,
    ownerUserId: row.ownerUserId ?? undefined,
    workspaceId: row.collaborationWorkspaceId ?? undefined,
    origin: row.origin,
    target: row.target,
    conversationId: row.conversationId ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    inputHash: row.inputHash,
    inputRef: row.inputRef ?? undefined,
    status: row.status,
    attempt: row.attempt,
    decision: row.decision ?? undefined,
    approvalRequestId: row.approvalRequestId ?? undefined,
    output: row.output ?? undefined,
    resultRef: row.resultRef ?? undefined,
    error: row.error
      ? {
          code: row.error.code,
          message: row.error.message,
          ...(row.error.reason === undefined ? {} : { reason: row.error.reason }),
          ...(row.error.unexecuted ? { unexecuted: true } : {})
        }
      : undefined,
    denial: row.error?.denial,
    usage: row.usage ?? undefined,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/**
 * `enqueued` hears of every job the store queues: the job of a Workflow step that waited for a
 * run that ended.
 */
export function createPostgresOperationRunsStore(
  db: PostgresConnection,
  enqueued: () => void = () => undefined
): OperationRunStore {
  const settle = async (
    input: { clientInstanceId: OperationRun["clientInstanceId"]; id: string },
    write: (tx: PostgresConnection) => Promise<OperationRun | undefined>
  ) => {
    let woke = false;
    const settled = await db.transaction(async (tx) => {
      const seen = await getOperationRun(tx, input);
      // Queue changes, decisions and Stop all take conversation -> run -> call.
      if (seen?.approvalRequestId && seen.origin.kind === "agent") {
        await lockAgentRunConversations(tx, input.clientInstanceId, [seen.origin.agentRunId]);
        await tx
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.clientInstanceId, input.clientInstanceId),
              eq(agentRuns.id, seen.origin.agentRunId)
            )
          )
          .for("update");
      }
      const run = await write(tx);
      if (run) await resumeApproval(tx, run);
      if (run) woke = await wakeStepsWaitingFor(tx, run);
      return run;
    });
    if (woke) enqueued();
    return settled;
  };
  return {
    create: (run) => createOperationRun(db, run),
    recordEnded: (run) => recordEndedOperationRun(db, run),
    finish: (input) => settle(input, (tx) => finishOperationRun(tx, input)),
    findByIdempotencyKey: (input) => findOperationRunByIdempotencyKey(db, input),
    get: (input) => getOperationRun(db, input),
    list: (input) => listOperationRuns(db, input),
    resume: (input) => resumeOperationRun(db, input),
    approveWaiting: async (input) => {
      let resumesAgent = false;
      // A confirmation in the Inbox waits `pending_confirmation`, an approval
      // `pending_approval`; each takes only the decision of its own kind.
      const waitingStatus =
        input.decision.mode === "confirmed" ? "pending_confirmation" : "pending_approval";
      const run = await settle(input, async (tx) => {
        const seen = await getOperationRun(tx, input);
        if (!seen || seen.status !== waitingStatus || !seen.expiresAt) return undefined;
        if (waitingStatus === "pending_confirmation" && !seen.approvalRequestId) return undefined;
        if (seen.origin.kind === "agent") {
          const [agent] = await tx
            .select({ status: agentRuns.status })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.clientInstanceId, input.clientInstanceId),
                eq(agentRuns.id, seen.origin.agentRunId)
              )
            );
          // Older releases completed the agent turn while leaving its approval in the
          // Inbox. Those requests retain their standalone executor after an upgrade.
          if (
            agent?.status === "failed" ||
            agent?.status === "cancelled" ||
            agent?.status === "cancelling"
          )
            return undefined;
          resumesAgent = agent !== undefined && agent.status !== "completed";
        }
        // Agent attribution on a standalone call names no resumable run. It keeps the
        // standalone executor; only an actual Agent Run records its approval here. A
        // confirmation always records its decision: it is what lets the call be taken.
        if (!resumesAgent && waitingStatus === "pending_approval") return seen;
        const [row] = await tx
          .update(operationRuns)
          .set({ decision: input.decision, updatedAt: sql`now()` })
          .where(
            and(
              identity(input),
              eq(operationRuns.status, waitingStatus),
              isNull(operationRuns.decision),
              sql`${operationRuns.expiresAt} > now()`
            )
          )
          .returning();
        return row ? mapOperationRun(row) : undefined;
      });
      return run ? { run, resumesAgent } : undefined;
    },
    holdConfirmedForApproval: async (input) => {
      const [row] = await db
        .update(operationRuns)
        .set({
          status: "pending_approval",
          approvalRequestId: input.approvalRequestId,
          inputRef: input.inputRef,
          expiresAt: new Date(input.expiresAt),
          // The new wait is another person's to decide; the confirmation stays on its item.
          decision: null,
          updatedAt: sql`now()`
        })
        .where(
          and(
            identity(input),
            eq(operationRuns.status, "pending_confirmation"),
            sql`${operationRuns.decision}->>'mode' = 'confirmed'`,
            sql`${operationRuns.origin}->>'kind' <> 'agent'`
          )
        )
        .returning();
      return row ? mapOperationRun(row) : undefined;
    },
    endWaiting: (input) => settle(input, (tx) => endWaitingOperationRun(tx, input)),
    markExpired: (input) => markOperationRunsExpired(db, input),
    listRunningSince: (input) => listOperationRunsRunningSince(db, input),
    deleteOfConversations: (input) => deleteOperationRunsOfConversations(db, input),
    deleteWithoutConversationOlderThan: (input) =>
      deleteOperationRunsWithoutConversationOlderThan(db, input),
    markInterrupted: (input) => settle(input, (tx) => markOperationRunInterrupted(tx, input))
  };
}

/** Only held agent calls have a waiting Agent Run to wake. */
async function resumeApproval(tx: PostgresConnection, run: OperationRun): Promise<void> {
  if (
    run.origin.kind !== "agent" ||
    !run.approvalRequestId ||
    (run.status === "pending_approval" && run.decision?.mode !== "approved") ||
    (run.status === "pending_confirmation" && run.decision?.mode !== "confirmed") ||
    run.status === "running"
  )
    return;
  await resumeAgentRunAfterApproval(tx, {
    clientInstanceId: run.clientInstanceId,
    agentRunId: run.origin.agentRunId
  });
}
