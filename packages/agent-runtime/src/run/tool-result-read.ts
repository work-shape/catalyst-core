import {
  isJsonObject,
  unknownToJsonValue,
  readToolResultMetadata,
  type ConversationHistoryStore,
  type ToolExecutionResult,
  type ToolOperationRunner
} from "@work-shape/catalyst-core";
import type { ModelTool } from "@work-shape/catalyst-model-provider";
import {
  TOOL_RESULT_READ_TOOL_NAME,
  modelOutputMaxChars,
  modelVisibleToolText,
  readToolExecutionResult,
  type ModelContextProjectionOptions
} from "../model-context-projection";

/** Room a page leaves for the line that says where it is. */
const PAGE_HEADER_CHARS = 200;

/**
 * The tool every run with tools is offered, always the same and always last, so the tool list
 * and the provider's prompt cache stay the same. It reads a result the model got cut, in parts.
 */
const toolResultReadTool: ModelTool = {
  kind: "function",
  name: TOOL_RESULT_READ_TOOL_NAME,
  description:
    "Read a tool result that was cut for you, in parts. A cut result names its id and the offset its left-out part starts at. Each answer names the offset to go on with.",
  inputJsonSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The id the cut result names." },
      offset: {
        type: "integer",
        minimum: 0,
        description: "The character to start at. 0 when left out."
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "The most characters to read. Left out: as many as one answer holds."
      }
    },
    required: ["id"],
    additionalProperties: false
  }
};

/** The run's tools with `tool_result.read` after them. A run without tools gets none. */
export function withToolResultRead(tools: ModelTool[]): ModelTool[] {
  return tools.some((tool) => tool.kind === "function") ? [...tools, toolResultReadTool] : tools;
}

/**
 * Reads a tool result of the run's own conversation, as the model would read it whole: a run
 * reaches only the results its conversation holds, as its history does.
 */
export function createToolResultReader(
  history: Pick<ConversationHistoryStore, "listMessages">,
  modelContext: ModelContextProjectionOptions
): ToolOperationRunner {
  return async (request, context) => {
    const input = readInput(request.input);
    if (typeof input === "string") return refused(input);
    const messages = await history.listMessages({
      clientInstanceId: context.clientInstanceId,
      conversationId: request.conversationId
    });
    let result: ToolExecutionResult | undefined;
    for (const message of messages) {
      if (message.role !== "tool") continue;
      const metadata = readToolResultMetadata(message.metadata);
      if (metadata?.toolCallId === input.id) result = readToolExecutionResult(metadata.result);
    }
    if (!result) return refused(`No tool result '${input.id}' in this conversation.`);
    const text = modelVisibleToolText(result);
    const pageChars = Math.max(1, modelOutputMaxChars(modelContext) - PAGE_HEADER_CHARS);
    const start = Math.min(input.offset, text.length);
    const end = Math.min(start + Math.min(input.limit ?? pageChars, pageChars), text.length);
    const where = end < text.length ? `Go on with offset ${end}.` : "This is its end.";
    return {
      status: "success",
      output: `[Result ${input.id}, characters ${start} to ${end} of ${text.length}. ${where}]\n${text.slice(start, end)}`
    };
  };
}

function readInput(value: unknown): { id: string; offset: number; limit?: number } | string {
  const json = unknownToJsonValue(value);
  if (!isJsonObject(json)) return "Give the id of the result.";
  const { id, offset, limit } = json;
  if (typeof id !== "string" || id === "") return "Give the id of the result.";
  if (
    offset !== undefined &&
    !(typeof offset === "number" && Number.isInteger(offset) && offset >= 0)
  )
    return "The offset is a whole number from 0.";
  if (limit !== undefined && !(typeof limit === "number" && Number.isInteger(limit) && limit >= 1))
    return "The limit is a whole number from 1.";
  return {
    id,
    offset: typeof offset === "number" ? offset : 0,
    ...(typeof limit === "number" ? { limit } : {})
  };
}

function refused(message: string): ToolExecutionResult {
  return { status: "failed", error: { code: "validation_failed", message } };
}
