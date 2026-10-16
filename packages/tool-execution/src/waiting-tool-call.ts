import {
  INTERRUPTED_RUN_ERROR,
  operationCallFromToolRequest,
  operationDenialError,
  type ToolDecisionRunner,
  type ToolExecutionResult
} from "@work-shape/catalyst-core";
import type { RunOperationDeps } from "./operation-execution";
import { toolResultFromOperationResult } from "./tool-operation";
import { failed } from "./tool-results";
import { executeConfirmedOperation, type ApprovedOperationEnd } from "./waiting-operation";

// The call an Agent Run paused on, once its person decided: executed once by its Operation
// Run, or answered as declined, in the run's worker (EW-2a).

/**
 * Carries out a decided call of a resumed Agent Run. A confirmed call is executed through
 * `executeConfirmedOperation`, keyed by its Operation Run, so a second worker or a second job
 * executes nothing. A call that was not executed answers the agent why: declined with the
 * person's reason, expired, or refused as the person is now.
 */
export function createDecidedToolCallRunner(callDeps: RunOperationDeps): ToolDecisionRunner {
  return async ({ request, operationRunId, frozenInput }, context) => {
    const run = await callDeps.runs.get({
      clientInstanceId: callDeps.clientInstanceId,
      id: operationRunId
    });
    if (!run || run.origin.kind !== "agent" || run.origin.agentRunId !== request.agentRunId) {
      return failed("handler_failed", "The call this run waited on no longer exists. Nothing ran.");
    }
    if (run.status === "denied" && run.decision?.mode === "declined") {
      const reason = run.decision.comment;
      return failed(
        "not_allowed",
        reason
          ? `The user declined this call. Nothing ran. Their reason: ${reason}`
          : "The user declined this call. Nothing ran."
      );
    }
    const call = operationCallFromToolRequest({
      request: { ...request, input: frozenInput },
      actor: {
        ...context.user,
        ...(context.principal ? { principal: context.principal } : {}),
        ...(context.subjectUserId ? { subjectUserId: context.subjectUserId } : {}),
        ...(context.delegatedActor ? { delegatedActor: context.delegatedActor } : {}),
        ...(context.scopes ? { scopes: context.scopes } : {})
      },
      operation: run.operation,
      effect: run.effect,
      correlationId: run.correlationId,
      ...(run.workspaceId ? { workspaceId: run.workspaceId } : {}),
      ...(run.idempotencyKey ? { idempotencyKey: run.idempotencyKey } : {}),
      ...(run.origin.toolRevisionId ? { toolRevisionId: run.origin.toolRevisionId } : {})
    });
    const end = await executeConfirmedOperation({ runId: run.id, call }, callDeps, {
      ...(context.signal ? { signal: context.signal } : {}),
      runtime: {
        ...(context.locale ? { locale: context.locale } : {}),
        ...(context.runFence ? { runFence: context.runFence } : {})
      }
    });
    return decidedToolResult(end, {
      toolName: request.toolName,
      agentName: request.agentName,
      correlationId: context.correlationId
    });
  };
}

function decidedToolResult(
  end: ApprovedOperationEnd,
  names: { toolName: string; agentName: string; correlationId: string }
): ToolExecutionResult {
  if (end.outcome) {
    return toolResultFromOperationResult(end.outcome, names);
  }
  switch (end.execution) {
    case "done":
      // A run that a first worker executed answers what it kept; its output is not repeated.
      return {
        status: "success",
        output: end.run?.output?.value ?? { status: "done" }
      };
    case "expired":
      return failed(
        "not_allowed",
        "This call waited for the user's confirmation and expired. Nothing ran."
      );
    case "refused":
      return failed(
        "not_allowed",
        end.run?.denial
          ? operationDenialError(end.run.denial).message
          : `${end.error.message} Nothing ran.`
      );
    case "interrupted":
      return failed(
        "handler_failed",
        `${INTERRUPTED_RUN_ERROR.message}. Its outcome is not known; check before calling again.`
      );
    case "failed":
      return failed("handler_failed", end.error.message);
  }
}
