import { apiOperations, type OperationRunResource } from "@vivd-catalyst/api-contract";
import type { OperationRun } from "@vivd-catalyst/core";

/** Where a run is read. Its page in the interface replaces this once it exists. */
export function operationRunHref(run: Pick<OperationRun, "id">): string {
  return apiOperations["operations.get_run"].buildPath({ params: { runId: run.id } });
}

/**
 * A run as a caller reads it. It leaves out what the run retains for a repeated call, the
 * caller's idempotency key and whom a delegated call was made through.
 */
export function toOperationRunResource(run: OperationRun): OperationRunResource {
  return {
    id: run.id,
    operation: run.operation,
    effect: run.effect,
    status: run.status,
    actor: { kind: run.actor.kind, id: run.actor.id, label: run.actor.label },
    origin: run.origin,
    workspaceId: run.workspaceId,
    approvalRequestId: run.approvalRequestId,
    inputHash: run.inputHash,
    attempt: run.attempt,
    decision: run.decision && {
      mode: run.decision.mode,
      by: run.decision.by,
      at: run.decision.at,
      comment: run.decision.comment
    },
    error: run.error,
    correlationId: run.correlationId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    expiresAt: run.expiresAt,
    href: operationRunHref(run)
  };
}
