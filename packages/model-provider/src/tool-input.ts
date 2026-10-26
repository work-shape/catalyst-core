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

/**
 * The input of a call as it is sent back to the model, its object keys in order. A call read back
 * from storage, which keeps no key order, is then sent as the run sent it, and the provider's
 * prompt cache still holds the request up to it.
 */
export function serializeToolInput(toolCall: ModelToolCall): string {
  return toolCall.inputParseError?.rawInput ?? JSON.stringify(withSortedKeys(toolCall.input));
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, withSortedKeys(entry)])
  );
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
