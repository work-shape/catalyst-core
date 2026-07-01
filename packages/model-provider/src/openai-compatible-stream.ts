import { AppError } from "@vivd-catalyst/core";
import type { ModelCompletionStreamEvent } from "./types";
import { WEB_SEARCH_MODEL_TOOL_NAME } from "./types";
import {
  noReportedUsage,
  readOpenAiResponsesText,
  readOpenAiResponsesWebMetadata,
  readOpenAiResponsesWebSearchCallCount,
  toModelUsage,
  toResponsesModelUsage
} from "./openai-compatible-mapping";
import { parseToolInput } from "./tool-input";
import type {
  OpenAiCompatibleResponse,
  OpenAiResponsesResponse
} from "./openai-compatible-types";

interface OpenAiCompatibleStreamChunk {
  usage?: OpenAiCompatibleResponse["usage"];
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

interface OpenAiCompatibleStreamingToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface OpenAiResponsesStreamEvent {
  type: string;
  delta?: string;
  output_index?: number;
  summary_index?: number;
  item_id?: string;
  response?: {
    output?: OpenAiResponsesResponse["output"];
    output_text?: OpenAiResponsesResponse["output_text"];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };
    error?: {
      message?: string;
    } | null;
  };
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    status?: string;
    action?: unknown;
    [key: string]: unknown;
  };
  error?: {
    message?: string;
  };
}

export async function* streamOpenAiCompatibleCompletion(
  body: ReadableStream<Uint8Array>,
  toolNameMap: Map<string, string>
): AsyncIterable<ModelCompletionStreamEvent> {
  let text = "";
  let usage = noReportedUsage();
  const toolCalls = new Map<number, Partial<OpenAiCompatibleStreamingToolCall>>();

  for await (const data of readServerSentEventData(body)) {
    if (data === "[DONE]") {
      break;
    }
    const payload = parseStreamChunk(data);
    if (payload.usage) {
      usage = toModelUsage(payload.usage);
    }

    for (const choice of payload.choices ?? []) {
      const delta = choice.delta;
      if (!delta) {
        continue;
      }

      if (delta.content) {
        text += delta.content;
        yield {
          type: "text_delta",
          delta: delta.content
        };
      }

      for (const toolCall of delta.tool_calls ?? []) {
        const existing = toolCalls.get(toolCall.index) ?? { arguments: "" };
        toolCalls.set(toolCall.index, {
          ...existing,
          id: toolCall.id ?? existing.id,
          name: toolCall.function?.name ?? existing.name,
          arguments: `${existing.arguments ?? ""}${toolCall.function?.arguments ?? ""}`
        });
      }
    }
  }

  yield {
    type: "completed",
    completion: {
      text,
      toolCalls: [...toolCalls.values()]
        .filter((toolCall): toolCall is OpenAiCompatibleStreamingToolCall =>
          Boolean(toolCall.id && toolCall.name)
        )
        .map((toolCall) => ({
          toolCallId: toolCall.id,
          toolName: toolNameMap.get(toolCall.name) ?? toolCall.name,
          ...parseToolInput(toolCall.arguments)
        })),
      sources: [],
      citations: [],
      usage
    }
  };
}

export async function* streamOpenAiResponsesCompletion(
  body: ReadableStream<Uint8Array>,
  toolNameMap: Map<string, string>
): AsyncIterable<ModelCompletionStreamEvent> {
  let text = "";
  let usage = noReportedUsage();
  const toolCalls: OpenAiCompatibleStreamingToolCall[] = [];
  const reasoningItemsByOutputIndex = new Map<number, string>();
  let latestReasoningItemId: string | undefined;
  let finalResponse: OpenAiResponsesResponse | undefined;

  for await (const data of readServerSentEventData(body)) {
    if (data === "[DONE]") {
      break;
    }
    const payload = parseResponsesStreamEvent(data);

    if (payload.type === "response.output_item.added" && payload.item?.type === "web_search_call") {
      yield {
        type: "provider_tool_started",
        toolCallId: createResponsesProviderToolCallId(payload, WEB_SEARCH_MODEL_TOOL_NAME),
        toolName: WEB_SEARCH_MODEL_TOOL_NAME,
        input: readResponsesWebSearchToolInput(payload.item)
      };
      continue;
    }

    if (
      payload.type === "response.output_item.added" &&
      payload.item?.type === "reasoning" &&
      payload.item.id
    ) {
      latestReasoningItemId = payload.item.id;
      if (payload.output_index !== undefined) {
        reasoningItemsByOutputIndex.set(payload.output_index, payload.item.id);
      }
      continue;
    }

    if (payload.type === "response.reasoning_summary_part.added") {
      const id = createReasoningSummaryId(payload, reasoningItemsByOutputIndex, latestReasoningItemId);
      latestReasoningItemId = id.itemId;
      continue;
    }

    if (payload.type === "response.reasoning_summary_text.delta" && payload.delta) {
      const id = createReasoningSummaryId(payload, reasoningItemsByOutputIndex, latestReasoningItemId);
      latestReasoningItemId = id.itemId;
      yield {
        type: "reasoning_delta",
        id: id.partId,
        delta: payload.delta
      };
      continue;
    }

    if (payload.type === "response.output_text.delta" && payload.delta) {
      text += payload.delta;
      yield {
        type: "text_delta",
        delta: payload.delta
      };
      continue;
    }

    if (
      payload.type === "response.output_item.done" &&
      payload.item?.type === "web_search_call"
    ) {
      yield {
        type: "provider_tool_completed",
        toolCallId: createResponsesProviderToolCallId(payload, WEB_SEARCH_MODEL_TOOL_NAME),
        toolName: WEB_SEARCH_MODEL_TOOL_NAME,
        output: readResponsesWebSearchToolOutput(payload.item)
      };
      continue;
    }

    if (
      payload.type === "response.output_item.done" &&
      payload.item?.type === "function_call" &&
      payload.item.call_id &&
      payload.item.name
    ) {
      toolCalls.push({
        id: payload.item.call_id,
        name: payload.item.name,
        arguments: payload.item.arguments ?? "{}"
      });
      continue;
    }

    if (payload.type === "response.completed") {
      usage = toResponsesModelUsage(payload.response?.usage);
      finalResponse = payload.response;
      continue;
    }

    if (payload.type === "response.failed" || payload.type === "error") {
      const message =
        payload.response?.error?.message ?? payload.error?.message ?? "Model provider stream failed";
      throw new AppError("INTERNAL", message);
    }
  }

  const finalText = finalResponse ? readOpenAiResponsesText(finalResponse) : "";
  const webMetadata = finalResponse
    ? readOpenAiResponsesWebMetadata(finalResponse)
    : { sources: [], citations: [] };
  const webSearchCallCount = finalResponse
    ? readOpenAiResponsesWebSearchCallCount(finalResponse)
    : usage.webSearchCallCount;
  yield {
    type: "completed",
    completion: {
      text: text || finalText,
      toolCalls: toolCalls.map((toolCall) => ({
        toolCallId: toolCall.id,
        toolName: toolNameMap.get(toolCall.name) ?? toolCall.name,
        ...parseToolInput(toolCall.arguments)
      })),
      sources: webMetadata.sources,
      citations: webMetadata.citations,
      usage: {
        ...usage,
        webSearchCallCount
      }
    }
  };
}

function createResponsesProviderToolCallId(
  payload: OpenAiResponsesStreamEvent,
  toolName: string
): string {
  return (
    payload.item?.id ??
    payload.item_id ??
    (payload.output_index !== undefined ? `${toolName}:${payload.output_index}` : undefined) ??
    toolName
  );
}

function readResponsesWebSearchToolInput(item: NonNullable<OpenAiResponsesStreamEvent["item"]>): unknown {
  if (isRecord(item.action) && typeof item.action.query === "string") {
    return { query: item.action.query };
  }
  return {};
}

function readResponsesWebSearchToolOutput(item: NonNullable<OpenAiResponsesStreamEvent["item"]>): unknown {
  const action = isRecord(item.action) ? item.action : undefined;
  const sources = Array.isArray(action?.sources) ? action.sources : [];
  return {
    ...(item.status ? { status: item.status } : {}),
    ...(typeof action?.type === "string" ? { actionType: action.type } : {}),
    ...(typeof action?.query === "string" ? { query: action.query } : {}),
    ...(sources.length > 0 ? { sourceCount: sources.length } : {})
  };
}

function createReasoningSummaryId(
  payload: OpenAiResponsesStreamEvent,
  reasoningItemsByOutputIndex: Map<number, string>,
  latestReasoningItemId: string | undefined
): { itemId: string; partId: string } {
  const itemId =
    payload.item_id ??
    payload.item?.id ??
    (payload.output_index !== undefined ? reasoningItemsByOutputIndex.get(payload.output_index) : undefined) ??
    latestReasoningItemId ??
    "reasoning";
  const summaryIndex = payload.summary_index ?? 0;
  return {
    itemId,
    partId: `${itemId}:summary:${summaryIndex}`
  };
}

function parseStreamChunk(data: string): OpenAiCompatibleStreamChunk {
  try {
    return JSON.parse(data) as OpenAiCompatibleStreamChunk;
  } catch {
    throw new AppError("INTERNAL", "Model provider returned invalid stream JSON");
  }
}

function parseResponsesStreamEvent(data: string): OpenAiResponsesStreamEvent {
  try {
    return JSON.parse(data) as OpenAiResponsesStreamEvent;
  } catch {
    throw new AppError("INTERNAL", "Model provider returned invalid Responses stream JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function* readServerSentEventData(
  body: ReadableStream<Uint8Array>
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    yield* readCompleteDataLines(buffer, (remainingBuffer) => {
      buffer = remainingBuffer;
    });
  }

  buffer += decoder.decode();
  yield* readCompleteDataLines(`${buffer}\n`, () => {
    buffer = "";
  });
}

function* readCompleteDataLines(
  buffer: string,
  setRemainingBuffer: (buffer: string) => void
): Iterable<string> {
  let remainingBuffer = buffer;
  let newlineIndex = remainingBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = remainingBuffer.slice(0, newlineIndex).trimEnd();
    remainingBuffer = remainingBuffer.slice(newlineIndex + 1);
    if (line.startsWith("data:")) {
      yield line.slice("data:".length).trimStart();
    }
    newlineIndex = remainingBuffer.indexOf("\n");
  }
  setRemainingBuffer(remainingBuffer);
}
