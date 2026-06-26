import { AppError } from "@vivd-catalyst/core";
import type { ModelToolCall } from "./types";

export function parseToolInput(value: string): Pick<ModelToolCall, "input" | "inputParseError"> {
  try {
    return {
      input: value ? JSON.parse(value) : {}
    };
  } catch {
    return {
      input: {},
      inputParseError: {
        code: "invalid_json",
        message: "Tool input must be valid JSON",
        rawInput: value
      }
    };
  }
}

export function parseJsonObject(value: string): unknown {
  const parsed = parseToolInput(value);
  if (parsed.inputParseError) {
    throw new AppError("BAD_REQUEST", parsed.inputParseError.message);
  }
  return parsed.input;
}

export function serializeToolInput(toolCall: ModelToolCall): string {
  return toolCall.inputParseError?.rawInput ?? JSON.stringify(toolCall.input);
}
