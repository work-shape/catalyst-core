import {
  AppError,
  INTERRUPTED_RUN_ERROR,
  type OperationDefinition,
  type OperationResult,
  type OperationRun
} from "@work-shape/catalyst-core";

/** The result a run that has an outcome answers with, whoever asks again. */
export function recordedResult(
  held: OperationRun,
  definition: OperationDefinition,
  secretInput: boolean
): OperationResult {
  const runId = held.id;
  switch (held.status) {
    case "done":
      if (secretInput) {
        // The secret was in what the call sent, not in what it answered. Nothing is lost.
        throw new AppError(
          "OUTPUT_NOT_RETAINED",
          "The call was already carried out and its answer is not kept. To carry it out again, call with a new Idempotency-Key.",
          { operationRunId: runId }
        );
      }
      if (definition.secret) {
        // The secret went to the first call alone. Nothing here could answer it again.
        throw new AppError(
          "OUTPUT_NOT_RETAINED",
          "The call completed and its answer held a secret that is shown once and not kept. What the call created exists. If the secret is lost, revoke what the call created and call again with a new Idempotency-Key.",
          { operationRunId: runId }
        );
      }
      if (!held.output) {
        throw new AppError(
          "OUTPUT_NOT_RETAINED",
          "The call completed and its answer is not kept. Read the result from what it changed.",
          { operationRunId: runId }
        );
      }
      return { status: "done", runId, output: held.output.value };
    case "pending_approval":
      if (held.approvalRequestId === undefined || held.expiresAt === undefined) break;
      return {
        status: "pending_approval",
        runId,
        approvalRequestId: held.approvalRequestId,
        expiresAt: held.expiresAt
      };
    case "denied":
      if (!held.denial) break;
      return { status: "denied", runId, reason: held.denial };
    case "expired":
      return { status: "expired", runId };
    case "running":
      // The work of an operation that ends later goes on: the same call answers the same run.
      if (definition.completion) return { status: "running", runId };
      throw new AppError("OPERATION_IN_PROGRESS", "The first call with this key has not ended", {
        operationRunId: runId
      });
    case "pending_confirmation":
      throw new AppError("OPERATION_IN_PROGRESS", "The first call with this key has not ended", {
        operationRunId: runId
      });
    case "failed":
      if (!held.error) break;
      if (held.error.code === INTERRUPTED_RUN_ERROR.code) {
        // Nobody knows how far the first call got, so the key never runs it a second time.
        throw new AppError(
          "OPERATION_IN_PROGRESS",
          "The first call with this key was interrupted and its outcome is not known. Check what it changed, then call again with a new Idempotency-Key.",
          { operationRunId: runId, interrupted: true }
        );
      }
      // The call may have changed something before it failed. It answers its failure again;
      // another attempt takes a new key.
      return {
        status: "failed",
        runId,
        error: {
          code: held.error.code,
          message: held.error.message,
          ...(held.error.reason ? { details: { reason: held.error.reason } } : {})
        }
      };
  }
  throw new AppError("INTERNAL", `Operation run '${runId}' cannot be answered again`);
}
