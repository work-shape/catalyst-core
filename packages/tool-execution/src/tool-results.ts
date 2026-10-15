import {
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
