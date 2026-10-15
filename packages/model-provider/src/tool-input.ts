import { AppError, checkStorableTexts } from "@work-shape/catalyst-core";
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

/**
 * A tool call whose input holds a text Postgres cannot store, a NUL character or half of a
 * surrogate pair, becomes a call with unreadable input: it is stored with an empty input and
 * answered to the model as a tool error, so the model can send it again without. Stored as it
 * came, the input ended the whole run with INTERNAL. Every provider's calls pass through here.
 */
export function withStorableToolInput(toolCall: ModelToolCall): ModelToolCall {
  if (toolCall.inputParseError) return toolCall;
  // The input is the model's answer, bounded by its size: the walk needs no cap of its own.
  if (checkStorableTexts(toolCall.input, Number.POSITIVE_INFINITY) !== "unstorable") {
    return toolCall;
  }
  return {
    ...toolCall,
    input: {},
    inputParseError: {
      code: "invalid_text",
      message:
        "Tool input holds a NUL character or half of a surrogate pair, which cannot be kept. Send the call again without it."
    }
  };
}
