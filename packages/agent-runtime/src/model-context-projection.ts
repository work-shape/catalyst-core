import type {
  AgentRunId,
  ChatMessage,
  JsonObject,
  JsonValue,
  ToolExecutionResult
} from "@vivd-catalyst/core";
import type { ModelMessage, ModelToolCall } from "@vivd-catalyst/model-provider";

const METADATA_VERSION = 1;
const CHARS_PER_TOKEN = 4;

export interface ModelContextProjectionOptions {
  toolOutput: {
    maxTokens: number;
    maxBytes?: number;
  };
}

export interface ModelOutputProjection {
  content: string;
  notice?: JsonObject;
}

export interface StoredToolCall {
  toolCallId: string;
  toolName: string;
  input: JsonValue;
}

export function projectAgentVisibleHistory(
  messages: ChatMessage[],
  options: ModelContextProjectionOptions
): ModelMessage[] {
  return messages
    .map((message) => toModelHistoryMessage(message, options))
    .filter((message): message is ModelMessage => message !== undefined);
}

export function createAssistantToolCallsMetadata(input: {
  runId: AgentRunId;
  toolCalls: readonly ModelToolCall[];
}): JsonObject {
  return {
    agentRuntime: {
      version: METADATA_VERSION,
      kind: "assistant_tool_calls",
      runId: input.runId,
      toolCalls: input.toolCalls.map((toolCall) => ({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: unknownToJsonValue(toolCall.input)
      }))
    }
  };
}

export function createAssistantFinalMetadata(input: { runId: AgentRunId }): JsonObject {
  return {
    agentRuntime: {
      version: METADATA_VERSION,
      kind: "assistant_final",
      runId: input.runId
    }
  };
}

export function createToolResultMetadata(input: {
  runId: AgentRunId;
  toolCall: ModelToolCall;
  result: ToolExecutionResult;
  modelOutput: ModelOutputProjection;
}): JsonObject {
  return {
    agentRuntime: {
      version: METADATA_VERSION,
      kind: "tool_result",
      runId: input.runId,
      toolCallId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
      input: unknownToJsonValue(input.toolCall.input),
      result: unknownToJsonValue(input.result),
      modelOutput: input.modelOutput.content,
      ...(input.modelOutput.notice ? { projectionNotice: input.modelOutput.notice } : {})
    }
  };
}

export function createModelVisibleToolOutput(
  result: ToolExecutionResult,
  options: ModelContextProjectionOptions
): ModelOutputProjection {
  // Data-critical boundary: privateOutput and private rendered display data must never be
  // serialized into model-visible history. Private render-view tools return only a zero-data
  // acknowledgement through output unless they are explicitly implemented as non-private query tools.
  const content =
    result.status === "success"
      ? stringifyForModel(result.output ?? { status: "success" })
      : stringifyForModel(result.error);
  return boundModelOutput(content, options);
}

export function dropCurrentSubmittedMessage(messages: ChatMessage[], text: string): ChatMessage[] {
  const last = messages.at(-1);
  if (last?.role === "user" && last.text === text) {
    return messages.slice(0, -1);
  }
  return messages;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(unknownToJsonValue(value)));
}

function toModelHistoryMessage(
  message: ChatMessage,
  options: ModelContextProjectionOptions
): ModelMessage | undefined {
  if (message.role === "user" || message.role === "system") {
    return { role: message.role, content: message.text };
  }

  if (message.role === "assistant") {
    const toolCalls = readAssistantToolCalls(message.metadata);
    return toolCalls
      ? {
          role: "assistant",
          content: message.text,
          toolCalls
        }
      : {
          role: "assistant",
          content: message.text
        };
  }

  if (message.role === "tool") {
    const metadata = readToolResultMetadata(message.metadata);
    if (!metadata) {
      return undefined;
    }
    const result = readToolExecutionResult(metadata.result);
    const projected = result
      ? createModelVisibleToolOutput(result, options).content
      : typeof metadata.modelOutput === "string"
        ? metadata.modelOutput
        : message.text;
    return {
      role: "tool",
      toolCallId: metadata.toolCallId,
      content: projected
    };
  }

  return undefined;
}

function readAssistantToolCalls(metadata: JsonObject | undefined): ModelToolCall[] | undefined {
  const runtime = readRuntimeMetadata(metadata);
  if (runtime?.kind !== "assistant_tool_calls" || !Array.isArray(runtime.toolCalls)) {
    return undefined;
  }
  const toolCalls: ModelToolCall[] = [];
  for (const value of runtime.toolCalls) {
    if (!isJsonObject(value)) {
      continue;
    }
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    const toolName = typeof value.toolName === "string" ? value.toolName : undefined;
    if (!toolCallId || !toolName) {
      continue;
    }
    toolCalls.push({
      toolCallId,
      toolName,
      input: value.input
    });
  }
  return toolCalls.length > 0 ? toolCalls : undefined;
}

function readToolResultMetadata(metadata: JsonObject | undefined):
  | {
      toolCallId: string;
      result?: JsonValue;
      modelOutput?: JsonValue;
    }
  | undefined {
  const runtime = readRuntimeMetadata(metadata);
  if (runtime?.kind !== "tool_result") {
    return undefined;
  }
  const toolCallId = typeof runtime.toolCallId === "string" ? runtime.toolCallId : undefined;
  if (!toolCallId) {
    return undefined;
  }
  return {
    toolCallId,
    result: runtime.result,
    modelOutput: runtime.modelOutput
  };
}

function readRuntimeMetadata(metadata: JsonObject | undefined): JsonObject | undefined {
  const runtime = metadata?.agentRuntime;
  return isJsonObject(runtime) && runtime.version === METADATA_VERSION ? runtime : undefined;
}

function readToolExecutionResult(value: JsonValue | undefined): ToolExecutionResult | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  if (value.status === "success") {
    return value as unknown as ToolExecutionResult;
  }
  if (
    (value.status === "failed" || value.status === "cancelled" || value.status === "timed_out") &&
    isJsonObject(value.error)
  ) {
    return value as unknown as ToolExecutionResult;
  }
  return undefined;
}

function boundModelOutput(
  content: string,
  options: ModelContextProjectionOptions
): ModelOutputProjection {
  const originalBytes = byteLength(content);
  const originalTokens = estimateTokens(content);
  const maxBytes = options.toolOutput.maxBytes;
  const maxTokens = options.toolOutput.maxTokens;
  const overTokenLimit = originalTokens > maxTokens;
  const overByteLimit = maxBytes !== undefined && originalBytes > maxBytes;
  if (!overTokenLimit && !overByteLimit) {
    return { content };
  }

  const maxCharsByTokens = maxTokens * CHARS_PER_TOKEN;
  const maxCharsByBytes = maxBytes ?? Number.POSITIVE_INFINITY;
  const maxChars = Math.max(1000, Math.min(maxCharsByTokens, maxCharsByBytes));
  const marker = [
    "",
    "[Tool output bounded for active model context]",
    `Original estimate: ${originalTokens} tokens / ${originalBytes} bytes.`,
    `Projected limit: ${maxTokens} tokens${maxBytes ? ` / ${maxBytes} bytes` : ""}.`,
    "The full tool output remains stored in agent-visible history and may be available as a managed artifact."
  ].join("\n");
  const markerBudget = marker.length + 8;
  const contentBudget = Math.max(0, maxChars - markerBudget);
  const headLength = Math.ceil(contentBudget / 2);
  const tailLength = Math.floor(contentBudget / 2);
  const bounded =
    content.length <= contentBudget
      ? content
      : `${content.slice(0, headLength)}${marker}\n${content.slice(content.length - tailLength)}`;

  return {
    content: bounded,
    notice: {
      type: "tool_output_bounded",
      originalTokens,
      originalBytes,
      projectedTokens: estimateTokens(bounded),
      projectedBytes: byteLength(bounded),
      maxTokens,
      ...(maxBytes ? { maxBytes } : {})
    }
  };
}

function stringifyForModel(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(unknownToJsonValue(value), null, 2);
}

export function unknownToJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(value as number) || typeof value !== "number" ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(unknownToJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    const result: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested !== "undefined" && typeof nested !== "function" && typeof nested !== "symbol") {
        result[key] = unknownToJsonValue(nested);
      }
    }
    return result;
  }
  if (typeof value === "undefined") {
    return null;
  }
  return String(value);
}

function sortForStableStringify(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }
  if (isJsonObject(value)) {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortForStableStringify(value[key] as JsonValue);
    }
    return sorted;
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}
