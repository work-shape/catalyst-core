import { keysetFilter } from "./paging";
import { and, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import {
  AppError,
  createPlatformId,
  type ApprovalRequest,
  type ApprovalRequestStore,
  type PlatformStores
} from "@vivd-catalyst/core";
import { requireClaimedAgentRun } from "./postgres-agent-run-worker-operations";
import type { PostgresConnection } from "./postgres-database";
import { mapApprovalRequest } from "./rows";
import { approvalRequests } from "./schema";
import { appendApprovalDecision } from "./postgres-conversation-operations";

export async function createApprovalRequest(
  db: PostgresConnection,
  input: Parameters<ApprovalRequestStore["createApprovalRequest"]>[0]
): Promise<ApprovalRequest> {
  const { runFence, pendingLimits, ...request } = input;
  const insert = async (tx: PostgresConnection) => {
    const now = new Date();
    const [row] = await tx
      .insert(approvalRequests)
      .values({
        ...request,
        id: createPlatformId("apr"),
        status: "pending",
        checks: request.checks ?? [],
        createdAt: now,
        updatedAt: now
      })
      .returning();
    if (!row) throw new AppError("INTERNAL", "Failed to create approval request");
    return mapApprovalRequest(row);
  };
  if (!runFence && !pendingLimits) return insert(db);
  return db.transaction(async (tx) => {
    if (runFence) await requireClaimedAgentRun(tx, request.clientInstanceId, runFence);
    if (pendingLimits) await requireBelowPendingLimits(tx, request, pendingLimits);
    return insert(tx);
  });
}

/**
 * Counts the pending requests of the kind under a lock that every filing of that kind on the
 * instance takes, held until the insert commits. Of two requests filed at the same moment the
 * second counts the first.
 */
async function requireBelowPendingLimits(
  tx: PostgresConnection,
  request: Pick<ApprovalRequest, "clientInstanceId" | "kind" | "requestedBy">,
  limits: NonNullable<Parameters<ApprovalRequestStore["createApprovalRequest"]>[0]["pendingLimits"]>
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`approval_requests:${request.clientInstanceId}:${request.kind}`}, 0))`
  );
  const [row] = await tx
    .select({
      own: sql<number>`count(*) filter (where ${requestedBy(request.requestedBy.id)})::int`,
      all: count()
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.clientInstanceId, request.clientInstanceId),
        eq(approvalRequests.kind, request.kind),
        eq(approvalRequests.status, "pending")
      )
    );
  if (limits.perRequester !== undefined && (row?.own ?? 0) >= limits.perRequester) {
    throw new AppError("RATE_LIMITED", "Too many of your requests of this kind are pending", {
      limit: "requester",
      max: limits.perRequester
    });
  }
  if (limits.perKind !== undefined && (row?.all ?? 0) >= limits.perKind) {
    throw new AppError("RATE_LIMITED", "Too many requests of this kind are pending", {
      limit: "kind",
      max: limits.perKind
    });
  }
}

export async function getApprovalRequest(
  db: PostgresConnection,
  input: Parameters<ApprovalRequestStore["getApprovalRequest"]>[0]
): Promise<ApprovalRequest | undefined> {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.clientInstanceId, input.clientInstanceId),
        eq(approvalRequests.id, input.requestId)
      )
    )
    .limit(1);
  return row ? mapApprovalRequest(row) : undefined;
}

export async function listApprovalRequests(
  db: PostgresConnection,
  input: Parameters<ApprovalRequestStore["listApprovalRequests"]>[0]
): Promise<ApprovalRequest[]> {
  if (input.kinds.length === 0) return [];
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        listFilter(input),
        keysetFilter(input.page, [approvalRequests.createdAt, approvalRequests.id], true)
      )
    )
    .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id))
    .limit(input.page?.limit ?? 2147483647);
  return rows.map(mapApprovalRequest);
}

export async function countApprovalRequests(
  db: PostgresConnection,
  input: Parameters<ApprovalRequestStore["countApprovalRequests"]>[0]
): Promise<number> {
  if (input.kinds.length === 0) return 0;
  const [row] = await db.select({ count: count() }).from(approvalRequests).where(listFilter(input));
  return row?.count ?? 0;
}

/** Which requests a list holds. The list and its count share it, so they cannot disagree. */
function listFilter(input: Parameters<ApprovalRequestStore["countApprovalRequests"]>[0]) {
  return and(
    eq(approvalRequests.clientInstanceId, input.clientInstanceId),
    inArray(approvalRequests.kind, [...input.kinds]),
    input.status === undefined ? undefined : eq(approvalRequests.status, input.status),
    input.excludeStatus === undefined
      ? undefined
      : ne(approvalRequests.status, input.excludeStatus),
    input.requestedById === undefined ? undefined : requestedBy(input.requestedById),
    input.updatedSince === undefined
      ? undefined
      : gte(approvalRequests.updatedAt, input.updatedSince),
    input.conversationId === undefined
      ? undefined
      : sql`${approvalRequests.origin}->>'conversationId' = ${input.conversationId}`,
    input.payloadKey === undefined
      ? undefined
      : sql`jsonb_exists(${approvalRequests.payload}, ${input.payloadKey})`,
    input.subjectContains === undefined
      ? undefined
      : sql`${approvalRequests.payload} @> ${JSON.stringify({ subject: input.subjectContains })}::jsonb`
  );
}

export async function countPendingApprovalRequests(
  db: PostgresConnection,
  input: Parameters<ApprovalRequestStore["countPendingApprovalRequests"]>[0]
): Promise<number> {
  if (input.kinds.length === 0) return 0;
  const [row] = await db
    .select({ count: count() })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.clientInstanceId, input.clientInstanceId),
        inArray(approvalRequests.kind, [...input.kinds]),
        eq(approvalRequests.status, "pending")
      )
    );
  return row?.count ?? 0;
}

export async function countOwnApprovalRequests(
  db: PostgresConnection,
  input: Parameters<ApprovalRequestStore["countOwnApprovalRequests"]>[0]
): Promise<{ pending: number; total: number }> {
  if (input.kinds.length === 0) return { pending: 0, total: 0 };
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending')::int`,
      total: count()
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.clientInstanceId, input.clientInstanceId),
        requestedBy(input.requestedById),
        inArray(approvalRequests.kind, [...input.kinds])
      )
    );
  return { pending: row?.pending ?? 0, total: row?.total ?? 0 };
}

/** The expression of `approval_requests_client_requester_idx`, so the planner can use it. */
function requestedBy(userId: string) {
  return sql`(${approvalRequests.requestedBy}->>'id') = ${userId}`;
}

/**
 * Runs `fn` in a transaction with the stores bound to it, and tells the workers of a job that
 * was enqueued inside once it committed.
 */
export type TransactWithStores = <Result>(
  fn: (tx: PostgresConnection, stores: PlatformStores) => Promise<Result>
) => Promise<Result>;

export async function transitionPendingApprovalRequest(
  transact: TransactWithStores,
  input: Parameters<ApprovalRequestStore["transitionPendingApprovalRequest"]>[0]
): Promise<ApprovalRequest> {
  return transition(transact, input, "pending");
}
export async function transitionApprovedApprovalRequest(
  transact: TransactWithStores,
  input: Parameters<ApprovalRequestStore["transitionApprovedApprovalRequest"]>[0]
): Promise<ApprovalRequest> {
  return transition(transact, input, "approved");
}

/** Postgres answers a `FOR UPDATE NOWAIT` on a locked row with this code. */
const LOCK_NOT_AVAILABLE = "55P03";

function isLockNotAvailable(error: unknown): boolean {
  for (let cause = error, depth = 0; depth < 4; depth++) {
    if (typeof cause !== "object" || cause === null) return false;
    if ("code" in cause && cause.code === LOCK_NOT_AVAILABLE) return true;
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return false;
}

async function transition(
  transact: TransactWithStores,
  input: Parameters<ApprovalRequestStore["transitionPendingApprovalRequest"]>[0],
  expectedStatus: "pending" | "approved"
): Promise<ApprovalRequest> {
  return transact(async (tx, stores) => {
    const identity = and(
      eq(approvalRequests.clientInstanceId, input.clientInstanceId),
      eq(approvalRequests.id, input.requestId)
    );
    // The lock is not waited for. A decision that waited would hold its connection for as long
    // as the one before it takes, and a pool of waiting decisions serves nobody else.
    const [row] = await tx
      .select()
      .from(approvalRequests)
      .where(identity)
      .for("update", { noWait: true })
      .limit(1)
      .catch((error: unknown) => {
        if (isLockNotAvailable(error)) {
          throw new AppError("CONFLICT", "Approval request is being decided right now");
        }
        throw error;
      });
    if (!row) throw new AppError("NOT_FOUND", "Approval request was not found");
    if (row.status !== expectedStatus)
      throw new AppError("CONFLICT", `Approval request is no longer ${expectedStatus}`);
    const outcome = await input.resolve(mapApprovalRequest(row), stores);
    const [updated] = await tx
      .update(approvalRequests)
      .set({
        status: outcome.status,
        decision: outcome.decision
          ? { ...outcome.decision, ...(outcome.reversion ? { reversion: outcome.reversion } : {}) }
          : null,
        applyResult: outcome.applyResult ?? null,
        ...(outcome.payload ? { payload: outcome.payload } : {}),
        updatedAt: new Date()
      })
      .where(and(identity, eq(approvalRequests.status, expectedStatus)))
      .returning();
    if (!updated) throw new AppError("CONFLICT", `Approval request is no longer ${expectedStatus}`);
    const request = mapApprovalRequest(updated);
    await appendApprovalDecision(tx, request);
    return request;
  });
}

export async function replaceEndedApprovalRequestPayload(
  db: PostgresConnection,
  input: Parameters<ApprovalRequestStore["replaceEndedApprovalRequestPayload"]>[0]
): Promise<boolean> {
  const rows = await db
    .update(approvalRequests)
    .set({ payload: input.payload })
    .where(
      and(
        eq(approvalRequests.clientInstanceId, input.clientInstanceId),
        eq(approvalRequests.id, input.requestId),
        ne(approvalRequests.status, "pending")
      )
    )
    .returning({ id: approvalRequests.id });
  return rows.length > 0;
}
