import { AppError } from "@vivd-catalyst/core";
import type {
  ModelAdapterStreamEvent,
  ModelCompletionStreamEvent,
  ModelProviderContinuation
} from "./types";
import { WEB_SEARCH_MODEL_TOOL_NAME } from "./types";
import {
  noReportedUsage,
  readProviderServiceTier,
  createOpenAiResponsesContinuation,
  didOpenAiResponsesCompact,
  readOpenAiResponsesText,
  readOpenAiResponsesWebMetadata,
  readOpenAiResponsesWebSearchCallCount,
  toModelUsage,
  toResponsesModelUsage,
  type ProviderToolNames
} from "./openai-compatible-mapping";
import {
  ModelProviderError,
  modelProviderErrorKindForStatus,
  toModelTransportFailure
} from "./model-provider-error";
import { readProviderErrorMessage, readProviderErrorMetadata } from "./provider-error";
import { parseToolInput } from "./tool-input";
import type { OpenAiCompatibleResponse, OpenAiResponsesResponse } from "./openai-compatible-types";

interface OpenAiCompatibleStreamChunk {
  usage?: OpenAiCompatibleResponse["usage"];
  service_tier?: string | null;
  choices?: Array<{
    finish_reason?: string | null;
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
    service_tier?: OpenAiResponsesResponse["service_tier"];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      input_tokens_details?: {
        cached_tokens?: number | null;
      };
    };
    error?: {
      code?: string;
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
    code?: string;
    message?: string;
  };
  code?: string;
  message?: string;
}

export async function* streamOpenAiCompatibleCompletion(
  body: ReadableStream<Uint8Array>,
  toolNames: ProviderToolNames
): AsyncIterable<ModelAdapterStreamEvent> {
  let text = "";
  let usage = noReportedUsage();
  let serviceTier: { providerServiceTier?: string } = {};
  let completed = false;
  const toolCalls = new Map<
    number,
    Partial<OpenAiCompatibleStreamingToolCall> & { repeatName: string }
  >();
  const announcedToolCalls = new Set<number>();
  const completeToolNames = new Set<number>();

  // Pieces alone cannot distinguish aa split as a, a from a repeated twice.
  // The request's table settles this when only a or aa is offered. If both are offered,
  // the repeat reading a wins. This needs a tool whose name is exactly another offered
  // tool's name written twice and a provider that splits it exactly in the middle.
  // The call is then still answered by a tool the agent was offered.
  function settledWireName(toolCall: { name?: string; repeatName: string }): string {
    if (toolNames.toolNameMap.has(toolCall.repeatName)) return toolCall.repeatName;
    if (toolCall.name !== undefined && toolNames.toolNameMap.has(toolCall.name)) {
      return toolCall.name;
    }
    return toolCall.repeatName;
  }

  function* announceReadyToolCalls(): Iterable<ModelAdapterStreamEvent> {
    for (const [index, toolCall] of [...toolCalls].sort(([a], [b]) => a - b)) {
      const productName = toolNames.toolNameMap.get(settledWireName(toolCall));
      if (
        completeToolNames.has(index) &&
        toolCall.id &&
        productName !== undefined &&
        !announcedToolCalls.has(index)
      ) {
        announcedToolCalls.add(index);
        yield { type: "tool_call_preparing", toolCallId: toolCall.id, toolName: productName };
      }
    }
  }

  for await (const data of readServerSentEventData(body)) {
    if (data === "[DONE]") {
      for (const index of toolCalls.keys()) completeToolNames.add(index);
      yield* announceReadyToolCalls();
      completed = true;
      break;
    }
    const payload = parseStreamChunk(data);
    if (payload.usage) {
      usage = toModelUsage(payload.usage);
    }
    serviceTier = { ...serviceTier, ...readProviderServiceTier(payload) };
    if (payload.usage) {
      // Handed on at once: a connection that breaks before the completion marker keeps it.
      yield { type: "usage_reported", usage: { ...usage, ...serviceTier } };
    }

    const inputDeltas: string[] = [];
    for (const choice of payload.choices ?? []) {
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        yield {
          type: "text_delta",
          delta: delta.content
        };
      }

      for (const toolCall of delta?.tool_calls ?? []) {
        const existing = toolCalls.get(toolCall.index) ?? { arguments: "", repeatName: "" };
        const namePiece = toolCall.function?.name ?? "";
        const updated = {
          ...existing,
          id: toolCall.id ?? existing.id,
          name: `${existing.name ?? ""}${namePiece}`,
          repeatName:
            namePiece === existing.repeatName
              ? existing.repeatName
              : existing.repeatName + namePiece,
          arguments: `${existing.arguments ?? ""}${toolCall.function?.arguments ?? ""}`
        };
        toolCalls.set(toolCall.index, updated);
        for (const index of toolCalls.keys()) {
          if (index < toolCall.index) completeToolNames.add(index);
        }
        if (toolCall.function?.arguments) {
          completeToolNames.add(toolCall.index);
          inputDeltas.push(toolCall.function.arguments);
        }
      }
    }
    if (payload.choices?.some((choice) => choice.finish_reason != null)) {
      for (const index of toolCalls.keys()) completeToolNames.add(index);
    }
    // Announce all ready names in index order before forwarding this chunk's input.
    yield* announceReadyToolCalls();
    for (const delta of inputDeltas) {
      yield { type: "tool_call_input_delta", delta };
    }
  }

  if (!completed) {
    throw new AppError("TIMEOUT", "Model provider stream ended before the completion marker");
  }

  yield {
    type: "completed",
    completion: {
      text,
      toolCalls: [...toolCalls.values()]
        .filter(
          (toolCall): toolCall is OpenAiCompatibleStreamingToolCall & { repeatName: string } =>
            Boolean(toolCall.id && toolCall.name)
        )
        .map((toolCall) => ({
          toolCallId: toolCall.id,
          toolName: toolNames.productNameFor(settledWireName(toolCall)),
          ...parseToolInput(toolCall.arguments)
        })),
      sources: [],
      citations: [],
      usage: { ...usage, ...serviceTier }
    }
  };
}

export async function* streamOpenAiResponsesCompletion(
  body: ReadableStream<Uint8Array>,
  productNameFor: (wireName: string) => string,
  providerId: string,
  previousContinuation: ModelProviderContinuation | undefined,
  headers?: Headers
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

    if (
      payload.type === "response.output_item.added" &&
      payload.item?.type === "function_call" &&
      payload.item.call_id &&
      payload.item.name
    ) {
      yield {
        type: "tool_call_preparing",
        toolCallId: payload.item.call_id,
        toolName: productNameFor(payload.item.name)
      };
      continue;
    }

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
      const id = createReasoningSummaryId(
        payload,
        reasoningItemsByOutputIndex,
        latestReasoningItemId
      );
      latestReasoningItemId = id.itemId;
      continue;
    }

    if (payload.type === "response.reasoning_summary_text.delta" && payload.delta) {
      const id = createReasoningSummaryId(
        payload,
        reasoningItemsByOutputIndex,
        latestReasoningItemId
      );
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

    if (payload.type === "response.output_item.done" && payload.item?.type === "web_search_call") {
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
      const metadata = readProviderErrorMetadata(payload.response ?? payload, headers);
      const { providerErrorCode } = metadata;
      // The request was accepted with 200, so the failure carries no HTTP status. Map the
      // provider's own transient codes to one, which is what callers retry on.
      const status =
        providerErrorCode === "server_error"
          ? 500
          : providerErrorCode === "rate_limit_exceeded"
            ? 429
            : undefined;
      throw new ModelProviderError({
        kind: status ? modelProviderErrorKindForStatus(status) : "invalid_request",
        message: "Model provider stream failed",
        status,
        providerCode: providerErrorCode,
        providerRequestId: metadata.requestId,
        retryAfterMs: metadata.retryAfterMs,
        providerMessage: readProviderErrorMessage(payload.response ?? payload),
        details: { providerId, ...metadata, ...(status ? { status } : {}) }
      });
    }
  }

  if (!finalResponse) {
    throw new AppError("TIMEOUT", "Model provider stream ended before response.completed");
  }

  const finalText = readOpenAiResponsesText(finalResponse);
  const webMetadata = readOpenAiResponsesWebMetadata(finalResponse);
  const webSearchCallCount = readOpenAiResponsesWebSearchCallCount(finalResponse);
  yield {
    type: "completed",
    completion: {
      text: text || finalText,
      toolCalls: toolCalls.map((toolCall) => ({
        toolCallId: toolCall.id,
        toolName: productNameFor(toolCall.name),
        ...parseToolInput(toolCall.arguments)
      })),
      sources: webMetadata.sources,
      citations: webMetadata.citations,
      continuation: createOpenAiResponsesContinuation(
        providerId,
        finalResponse,
        previousContinuation
      ),
      contextManagement: {
        compacted: didOpenAiResponsesCompact(finalResponse)
      },
      usage: {
        ...usage,
        webSearchCallCount,
        ...readProviderServiceTier(finalResponse)
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

function readResponsesWebSearchToolInput(
  item: NonNullable<OpenAiResponsesStreamEvent["item"]>
): unknown {
  if (isRecord(item.action) && typeof item.action.query === "string") {
    return { query: item.action.query };
  }
  return {};
}

function readResponsesWebSearchToolOutput(
  item: NonNullable<OpenAiResponsesStreamEvent["item"]>
): unknown {
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
    (payload.output_index !== undefined
      ? reasoningItemsByOutputIndex.get(payload.output_index)
      : undefined) ??
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

/** The `data` of each server-sent event of a response body, read under the idle limit. */
export async function* readServerSentEventData(
  body: ReadableStream<Uint8Array>
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new ServerSentEventDataLineParser();

  let ended = false;
  try {
    while (true) {
      const { done, value } = await readWithinIdleLimit(reader);
      if (done) {
        ended = true;
        break;
      }
      yield* parser.push(decoder.decode(value, { stream: true }));
    }

    yield* parser.push(decoder.decode(), true);
  } finally {
    // A consumer that stops reading, or fails, leaves a response the provider still writes.
    // Cancelling the body ends the request, so the provider stops generating.
    if (!ended) {
      await reader.cancel().catch(() => undefined);
    }
  }
}

/**
 * A provider can accept a request and then send nothing more. Long reasoning is quiet for
 * minutes, so the limit is generous; past it the request is given up as a timeout, which callers
 * retry.
 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

async function readWithinIdleLimit(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AppError("TIMEOUT", "Model provider stream sent no data for 10 minutes")),
      MODEL_STREAM_IDLE_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    // The stream was cut while it was read, or the caller stopped it.
    throw toModelTransportFailure(error);
  } finally {
    clearTimeout(timer);
  }
}

export class ServerSentEventDataLineParser {
  private readonly pendingLineFragments: string[] = [];

  push(chunk: string, end = false): string[] {
    const dataLines: string[] = [];
    let lineStart = 0;
    let newlineIndex = chunk.indexOf("\n", lineStart);

    while (newlineIndex >= 0) {
      const lineFragment = chunk.slice(lineStart, newlineIndex);
      dataLines.push(...this.completeLine(lineFragment));
      lineStart = newlineIndex + 1;
      newlineIndex = chunk.indexOf("\n", lineStart);
    }

    if (lineStart < chunk.length) {
      this.pendingLineFragments.push(chunk.slice(lineStart));
    }
    if (end && this.pendingLineFragments.length > 0) {
      dataLines.push(...this.completeLine(""));
    }

    return dataLines;
  }

  private completeLine(finalFragment: string): string[] {
    const line =
      this.pendingLineFragments.length === 0
        ? finalFragment
        : [...this.pendingLineFragments, finalFragment].join("");
    this.pendingLineFragments.length = 0;
    const normalizedLine = line.trimEnd();
    if (!normalizedLine.startsWith("data:")) {
      return [];
    }
    return [normalizedLine.slice("data:".length).trimStart()];
  }
}
