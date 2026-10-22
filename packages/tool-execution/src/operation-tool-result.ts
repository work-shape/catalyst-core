import {
  INTERRUPTED_RUN_ERROR,
  type ToolExecutionResult,
  type ToolHandlerFailureResult
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { previewToolResult } from "./agent-preview";
import type { OperationOutcome } from "./operation-execution";
import { denialText, type ToolCallNames } from "./tool-refusal-text";
import { failed } from "./tool-results";

/**
 * Projects what a call came to back to the agent that made it as a tool call. A tool that ran
 * answers its own result unchanged. A call that was refused, held or cut off before the tool
 * ran answers in the words an agent has always read for it.
 */
export function toolResultFromOperationResult(
  outcome: Pick<OperationOutcome, "result" | "toolResult">,
  names: ToolCallNames
): ToolExecutionResult {
  if (outcome.toolResult) return outcome.toolResult;
  const { result } = outcome;
  switch (result.status) {
    case "done":
      return {
        status: "success",
        output: result.output,
        ...(result.display ? { display: result.display } : {}),
        ...(result.structuredResult ? { structuredResult: result.structuredResult } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {})
      };
    case "running":
      // The operation's work goes on after the call; its run says when it ended.
      return { status: "success", output: { status: "running", operationRunId: result.runId } };
    case "denied":
      if (names.useRightRefusal) return failed("permission_missing", names.useRightRefusal);
      return result.reason.kind === "policy" && result.reason.reason === "confirmation_required"
        ? failed("confirmation_required", denialText(result.reason, names), {
            operation: result.reason.operation
          })
        : failed("not_allowed", denialText(result.reason, names));
    case "failed":
      // The error envelope replaces an unexposed message with this fixed text. An exposed
      // timeout message is the handler's answer and must reach the agent unchanged.
      if (result.error.code === "TIMEOUT" && result.error.message === "Internal server error")
        return toolTimeoutFailure(names);
      return result.error.code === "INTERNAL"
        ? internalFailure(names.correlationId)
        : // The message is all the model reads. A fixed reason stays in the run and in the
          // details of the result, and is not handed on: a model repeats a code to the person.
          {
            ...failed(
              "handler_failed",
              result.error.code === INTERRUPTED_RUN_ERROR.code
                ? `${INTERRUPTED_RUN_ERROR.message}. Its outcome is not known; check before calling again.`
                : result.error.message
            ),
            ...privateConversationRecovery(result.error.details)
          };
    case "expired":
    case "pending_confirmation":
    case "pending_approval":
      return internalFailure(names.correlationId);
    case "dry_run":
      return previewToolResult(result, names.locale);
  }
}

/** Only this fixed recovery reaches the host; arbitrary server reasons stay private. */
export function privateConversationRecovery(
  details: unknown
): Pick<ToolHandlerFailureResult, "recovery"> {
  const parsed = z.object({ reason: z.literal("subject_conversation_shared") }).safeParse(details);
  return parsed.success ? { recovery: "private_conversation" } : {};
}

export function internalFailure(correlationId: string): ToolHandlerFailureResult {
  return failed(
    "handler_failed",
    `The tool failed with an internal error. Reference: ${correlationId}`,
    { correlationId }
  );
}

/** A timeout says nothing about whether an unacknowledged change happened. */
export function toolTimeoutFailure(
  names: Pick<ToolCallNames, "toolName" | "locale">
): ToolHandlerFailureResult {
  return {
    status: "timed_out",
    error: {
      code: "timed_out",
      message:
        names.locale === "de"
          ? `Das Tool '${names.toolName}' hat nicht rechtzeitig geantwortet. Das Ergebnis ist unbekannt; vor einem erneuten Aufruf prüfen.`
          : `The tool '${names.toolName}' did not answer in time. Its outcome is not known; check before calling again.`
    }
  };
}
