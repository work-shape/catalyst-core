import {
  type JsonObject,
  type ToolExecutionErrorCode,
  type ToolHandlerFailureResult
} from "@vivd-catalyst/core";

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

export function toPreview(input: unknown): JsonObject {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as JsonObject;
  }
  return { value: String(input) };
}
