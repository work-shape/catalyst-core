import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  AppError,
  createPlatformId,
  type ApprovalRequest,
  type ApprovalRequestStore
} from "@vivd-catalyst/core";
import type { PostgresDatabase } from "./postgres-database";
import { mapApprovalRequest } from "./rows";
import { approvalRequests } from "./schema";
import { appendApprovalDecision } from "./postgres-conversation-operations";

export async function createApprovalRequest(
  db: PostgresDatabase,
  input: Parameters<ApprovalRequestStore["createApprovalRequest"]>[0]
): Promise<ApprovalRequest> {
  const now = new Date();
  const [row] = await db
    .insert(approvalRequests)
    .values({
      ...input,
      id: createPlatformId("apr"),
      status: "pending",
      checks: input.checks ?? [],
      createdAt: now,
      updatedAt: now
    })
    .returning();
  if (!row) throw new AppError("INTERNAL", "Failed to create approval request");
  return mapApprovalRequest(row);
}

export async function getApprovalRequest(
  db: PostgresDatabase,
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
  db: PostgresDatabase,
  input: Parameters<ApprovalRequestStore["listApprovalRequests"]>[0]
): Promise<ApprovalRequest[]> {
  if (input.kinds.length === 0) return [];
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.clientInstanceId, input.clientInstanceId),
        inArray(approvalRequests.kind, [...input.kinds]),
        input.status === undefined ? undefined : eq(approvalRequests.status, input.status),
        input.conversationId === undefined
          ? undefined
          : sql`${approvalRequests.origin}->>'conversationId' = ${input.conversationId}`
      )
    )
    .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id))
    .limit(200);
  return rows.map(mapApprovalRequest);
}

export async function countPendingApprovalRequests(
  db: PostgresDatabase,
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

export async function transitionPendingApprovalRequest(
  db: PostgresDatabase,
  input: Parameters<ApprovalRequestStore["transitionPendingApprovalRequest"]>[0]
): Promise<ApprovalRequest> {
  return transition(db, input, "pending");
}
export async function transitionApprovedApprovalRequest(
  db: PostgresDatabase,
  input: Parameters<ApprovalRequestStore["transitionApprovedApprovalRequest"]>[0]
): Promise<ApprovalRequest> {
  return transition(db, input, "approved");
}
async function transition(
  db: PostgresDatabase,
  input: Parameters<ApprovalRequestStore["transitionPendingApprovalRequest"]>[0],
  expectedStatus: "pending" | "approved"
): Promise<ApprovalRequest> {
  return db.transaction(async (tx) => {
    const identity = and(
      eq(approvalRequests.clientInstanceId, input.clientInstanceId),
      eq(approvalRequests.id, input.requestId)
    );
    const [row] = await tx.select().from(approvalRequests).where(identity).for("update").limit(1);
    if (!row) throw new AppError("NOT_FOUND", "Approval request was not found");
    if (row.status !== expectedStatus)
      throw new AppError("CONFLICT", `Approval request is no longer ${expectedStatus}`);
    const outcome = await input.resolve(mapApprovalRequest(row));
    const [updated] = await tx
      .update(approvalRequests)
      .set({
        status: outcome.status,
        decision: outcome.decision
          ? { ...outcome.decision, ...(outcome.reversion ? { reversion: outcome.reversion } : {}) }
          : null,
        applyResult: outcome.applyResult ?? null,
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
