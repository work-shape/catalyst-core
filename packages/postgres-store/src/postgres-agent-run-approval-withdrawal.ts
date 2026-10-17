import { and, eq, or, sql } from "drizzle-orm";
import type { JsonObject } from "@work-shape/catalyst-core";
import { appendAuditEvent } from "./postgres-audit-usage-operations";
import { appendApprovalDecision } from "./postgres-conversation-operations";
import type { PostgresTransaction } from "./postgres-database";
import { mapApprovalRequest } from "./rows";
import { approvalRequests, operationRuns } from "./schema";

/** Called only after Stop locked and denied the still-waiting call. Never rewrites execution. */
export async function withdrawStoppedOperationApproval(
  tx: PostgresTransaction,
  call: typeof operationRuns.$inferSelect,
  stoppedAt: Date
): Promise<void> {
  if (!call.approvalRequestId) return;
  const identity = and(
    eq(approvalRequests.clientInstanceId, call.clientInstanceId),
    eq(approvalRequests.id, call.approvalRequestId)
  );
  const [seen] = await tx.select().from(approvalRequests).where(identity);
  if (!seen) return;
  // Keep the same preview fields as an ended held call, without its input or sign-in context.
  const payload: JsonObject = {
    actor: { id: call.actor.id, label: call.actor.label },
    inputRemoved: true
  };
  for (const key of [
    "runId",
    "operation",
    "effect",
    "origin",
    "workspaceId",
    "expiresAt",
    "subject",
    "subjectKind",
    "mode"
  ]) {
    const value = seen.payload[key];
    if (value !== undefined) payload[key] = value;
  }
  const [request] = await tx
    .update(approvalRequests)
    .set({
      status: "withdrawn",
      updatedAt: stoppedAt,
      applyResult: {
        runId: call.id,
        execution: "refused",
        error: { code: "CONFLICT", message: "run stopped" }
      },
      payload
    })
    .where(
      and(
        identity,
        or(
          eq(approvalRequests.status, "pending"),
          and(
            eq(approvalRequests.status, "approved"),
            sql`${approvalRequests.applyResult}->>'execution' = 'queued'`
          )
        )
      )
    )
    .returning();
  if (!request) return;
  await appendApprovalDecision(tx, mapApprovalRequest(request));
  await appendAuditEvent(tx, {
    clientInstanceId: call.clientInstanceId,
    type: "approval_request.withdrawn",
    status: "success",
    reason: "run stopped",
    correlationId: call.correlationId,
    metadata: { requestId: request.id, kind: request.kind, status: request.status }
  });
}
