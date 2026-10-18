import {
  type OperationResult,
  type ToolExecutionResult,
  type JsonObject,
  type ToolExecutionErrorCode,
  type ToolHandlerFailureResult
} from "@work-shape/catalyst-core";

export function failed(
  code: ToolExecutionErrorCode,
  message: string,
  details?: JsonObject
): ToolHandlerFailureResult {
  return {
    status: "failed",
    error: {
      code,
      message,
      details
    }
  };
}

export function toolOutput(result: ToolExecutionResult): unknown {
  return result.status === "success" ? result.output : undefined;
}

export function shownBesideOutput(
  result: Extract<ToolExecutionResult, { status: "success" }>
): Pick<
  Extract<OperationResult, { status: "done" }>,
  "display" | "structuredResult" | "artifacts"
> {
  return {
    ...(result.display ? { display: result.display } : {}),
    ...(result.structuredResult ? { structuredResult: result.structuredResult } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {})
  };
}

/** What a tool says about itself for the audit log: names and counts, never content. */
export function toolAuditFields(result: ToolExecutionResult): JsonObject {
  const summary = result.auditSummary;
  return {
    resultStatus: result.status,
    ...(summary
      ? {
          auditAction: summary.action,
          ...(summary.subject ? { auditSubject: summary.subject } : {}),
          ...(summary.metadata ? { auditMetadata: summary.metadata } : {})
        }
      : {})
  };
}
