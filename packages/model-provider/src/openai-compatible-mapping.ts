import { createHash } from "node:crypto";
import {
  AppError,
  type MessageCitation,
  type ModelTokenUsage,
  type WebSource
} from "@vivd-catalyst/core";
import {
  WEB_SEARCH_MODEL_TOOL_NAME,
  isModelFunctionTool,
  isModelProviderNativeTool,
  modelContentImages,
  modelContentText,
  type ModelContent,
  type ModelContentPart,
  type ModelFunctionTool,
  type ModelMessage,
  type ModelNativeToolId,
  type ModelProviderContinuation,
  type ModelProviderNativeTool,
  type ModelTool
} from "./types";
import { serializeToolInput } from "./tool-input";
import type {
  OpenAiCompatibleMessage,
  OpenAiCompatibleResponse,
  OpenAiResponseInput,
  OpenAiResponseInputItem,
  OpenAiResponsesCompactionItem,
  OpenAiResponsesInputContent,
  OpenAiResponsesOutputItem,
  OpenAiResponsesReasoningItem,
  OpenAiResponsesResponse,
  OpenAiResponsesTool,
  OpenAiResponsesUsage
} from "./openai-compatible-types";

// The longest string the Responses API accepts in a request: 20 MiB, the number its 400
// `string_above_max_length` names. A compaction or reasoning item above it is not kept as a
// continuation, so the conversation goes on from its own history; the user sees nothing. An image
// whose data URL would be longer (about 15 MiB of image bytes) is left out of the request, and the
// model is told so in its place.
export const OPENAI_RESPONSES_STRING_MAX_CHARS = 20_971_520;

export interface OpenAiCompatibleProviderTool {
  tool: ModelFunctionTool;
  providerName: string;
}

interface OpenAiResponsesContinuationState {
  kind: "openai_responses";
  compactionItem?: OpenAiResponsesCompactionItem;
  encryptedReasoningItems: Array<{
    beforeToolCallId: string;
    item: OpenAiResponsesReasoningItem;
  }>;
}

type OpenAiChatTextImageContent =
  | string
  | Array<
      | {
          type: "text";
          text: string;
        }
      | {
          type: "image_url";
          image_url: {
            url: string;
          };
        }
    >;

export function createProviderToolMetadata(tools: ModelTool[]): {
  providerTools: OpenAiCompatibleProviderTool[];
  providerNativeTools: ModelProviderNativeTool[];
  toolNameMap: Map<string, string>;
} {
  const providerTools = tools.filter(isModelFunctionTool).map((tool) => ({
    tool,
    providerName: toProviderToolName(tool.name)
  }));
  return {
    providerTools,
    providerNativeTools: tools.filter(isModelProviderNativeTool),
    toolNameMap: new Map(providerTools.map(({ tool, providerName }) => [providerName, tool.name]))
  };
}

/** Present only when the provider reports the tier that processed the call. */
export function readProviderServiceTier(payload: { service_tier?: string | null }): {
  providerServiceTier?: string;
} {
  return typeof payload.service_tier === "string" && payload.service_tier
    ? { providerServiceTier: payload.service_tier }
    : {};
}

export function toModelUsage(usage: OpenAiCompatibleResponse["usage"]): ModelTokenUsage & {
  webSearchCallCount: number;
} {
  if (!usage) {
    return noReportedUsage();
  }

  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens: normalizeCachedInputTokens(
      usage.prompt_tokens_details?.cached_tokens,
      usage.prompt_tokens
    ),
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    source: "provider_reported",
    webSearchCallCount: 0
  };
}

export function toResponsesModelUsage(
  usage: OpenAiResponsesUsage | undefined,
  webSearchCallCount = 0
): ModelTokenUsage & {
  webSearchCallCount: number;
} {
  if (!usage) {
    return {
      ...noReportedUsage(),
      webSearchCallCount
    };
  }

  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: normalizeCachedInputTokens(
      usage.input_tokens_details?.cached_tokens,
      usage.input_tokens
    ),
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    source: "provider_reported",
    webSearchCallCount
  };
}

export function noReportedUsage(): ModelTokenUsage & {
  webSearchCallCount: number;
} {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source: "not_reported",
    webSearchCallCount: 0
  };
}

function normalizeCachedInputTokens(
  value: number | null | undefined,
  inputTokens: number
): number | undefined {
  if (!Number.isFinite(value) || value === undefined || value === null) {
    return undefined;
  }
  return Math.min(Math.max(Math.trunc(value), 0), inputTokens);
}

export function toOpenAiChatMessages(messages: ModelMessage[]): OpenAiCompatibleMessage[] {
  const output: OpenAiCompatibleMessage[] = [];
  const pendingVisualMessages: OpenAiCompatibleMessage[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "tool") {
      flushPendingVisualMessages(output, pendingVisualMessages);
    }
    output.push(...toOpenAiChatMessagesForOne(message, pendingVisualMessages));
    if (message.role === "tool" && messages[index + 1]?.role !== "tool") {
      flushPendingVisualMessages(output, pendingVisualMessages);
    }
  });
  flushPendingVisualMessages(output, pendingVisualMessages);
  return output;
}

function toOpenAiChatMessagesForOne(
  message: ModelMessage,
  pendingVisualMessages: OpenAiCompatibleMessage[]
): OpenAiCompatibleMessage[] {
  if (message.role === "assistant") {
    return [
      {
        role: "assistant",
        content: modelContentText(message.content) || null,
        tool_calls: message.toolCalls?.map((toolCall) => ({
          id: toolCall.toolCallId,
          type: "function",
          function: {
            name: toProviderToolName(toolCall.toolName),
            arguments: serializeToolInput(toolCall)
          }
        }))
      }
    ];
  }

  if (message.role === "tool") {
    const text = modelContentText(message.content);
    const images = toImageInputs(modelContentImages(message.content));
    if (images.count > 0) {
      pendingVisualMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: withOmittedImagesNote(
              `Visual output from tool call ${message.toolCallId}.`,
              images.omittedCount
            )
          },
          ...images.dataUrls.map((url) => ({
            type: "image_url" as const,
            image_url: { url }
          }))
        ]
      });
    }
    return [
      {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: text
      }
    ];
  }

  return [
    {
      role: message.role,
      content:
        message.role === "system"
          ? modelContentText(message.content)
          : toOpenAiChatContent(message.content)
    }
  ];
}

export function toOpenAiResponsesInput(
  messages: ModelMessage[],
  encryptedReasoningItems: OpenAiResponsesContinuationState["encryptedReasoningItems"] = [],
  compactionItem?: OpenAiResponsesCompactionItem
): OpenAiResponseInput {
  const input: OpenAiResponseInput = [];
  const pendingVisualMessages: OpenAiResponseInputItem[] = [];
  const reasoningByToolCallId = new Map<string, OpenAiResponsesReasoningItem[]>();
  for (const entry of encryptedReasoningItems) {
    const items = reasoningByToolCallId.get(entry.beforeToolCallId) ?? [];
    items.push(entry.item);
    reasoningByToolCallId.set(entry.beforeToolCallId, items);
  }
  messages.forEach((message, index) => {
    if (message.role !== "tool") {
      flushPendingVisualMessages(input, pendingVisualMessages);
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content) {
        input.push({
          role: "assistant",
          content: modelContentText(message.content)
        });
      }
      for (const toolCall of message.toolCalls) {
        input.push(...(reasoningByToolCallId.get(toolCall.toolCallId) ?? []));
        input.push({
          type: "function_call",
          call_id: toolCall.toolCallId,
          name: toProviderToolName(toolCall.toolName),
          arguments: serializeToolInput(toolCall)
        });
      }
      return;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: modelContentText(message.content)
      });
      const images = toImageInputs(modelContentImages(message.content));
      if (images.count > 0) {
        pendingVisualMessages.push({
          role: "user",
          content: [
            {
              type: "input_text",
              text: withOmittedImagesNote(
                `Visual output from tool call ${message.toolCallId}.`,
                images.omittedCount
              )
            },
            ...images.dataUrls.map((url) => ({
              type: "input_image" as const,
              image_url: url
            }))
          ]
        });
      }
      if (messages[index + 1]?.role !== "tool") {
        flushPendingVisualMessages(input, pendingVisualMessages);
      }
      return;
    }

    if (message.role === "assistant") {
      input.push({
        role: "assistant",
        content: modelContentText(message.content)
      });
      return;
    }

    input.push({
      role: message.role,
      content:
        message.role === "system"
          ? modelContentText(message.content)
          : toOpenAiResponsesContent(message.content)
    });
  });
  flushPendingVisualMessages(input, pendingVisualMessages);
  if (!compactionItem) {
    return input;
  }
  const firstNonSystemIndex = input.findIndex(
    (item) => !("role" in item && item.role === "system")
  );
  const insertionIndex = firstNonSystemIndex < 0 ? input.length : firstNonSystemIndex;
  return [...input.slice(0, insertionIndex), compactionItem, ...input.slice(insertionIndex)];
}

export function readOpenAiResponsesContinuationItems(
  providerId: string,
  continuation: ModelProviderContinuation | undefined
): OpenAiResponsesContinuationState["encryptedReasoningItems"] {
  if (
    continuation?.providerId !== providerId ||
    !isUnknownRecord(continuation.state) ||
    continuation.state.kind !== "openai_responses" ||
    !Array.isArray(continuation.state.encryptedReasoningItems)
  ) {
    return [];
  }

  return continuation.state.encryptedReasoningItems.filter(
    (entry): entry is OpenAiResponsesContinuationState["encryptedReasoningItems"][number] =>
      isUnknownRecord(entry) &&
      typeof entry.beforeToolCallId === "string" &&
      isOpenAiResponsesReasoningItem(entry.item)
  );
}

export function readOpenAiResponsesCompactionItem(
  providerId: string,
  continuation: ModelProviderContinuation | undefined
): OpenAiResponsesCompactionItem | undefined {
  if (
    continuation?.providerId !== providerId ||
    !isUnknownRecord(continuation.state) ||
    continuation.state.kind !== "openai_responses"
  ) {
    return undefined;
  }
  return isOpenAiResponsesCompactionItem(continuation.state.compactionItem)
    ? continuation.state.compactionItem
    : undefined;
}

export function createOpenAiResponsesContinuation(
  providerId: string,
  payload: OpenAiResponsesResponse,
  previous: ModelProviderContinuation | undefined
): ModelProviderContinuation | undefined {
  const latestCompactionItem = readLatestCompactionItem(payload.output ?? []);
  const compactionItem =
    latestCompactionItem ?? readOpenAiResponsesCompactionItem(providerId, previous);
  const encryptedReasoningItems = [
    ...(latestCompactionItem ? [] : readOpenAiResponsesContinuationItems(providerId, previous)),
    ...readEncryptedReasoningItems(payload.output ?? [])
  ];
  return compactionItem || encryptedReasoningItems.length > 0
    ? {
        providerId,
        state: {
          kind: "openai_responses",
          ...(compactionItem ? { compactionItem } : {}),
          encryptedReasoningItems
        } satisfies OpenAiResponsesContinuationState
      }
    : undefined;
}

export function didOpenAiResponsesCompact(payload: OpenAiResponsesResponse): boolean {
  return Boolean(readLatestCompactionItem(payload.output ?? []));
}

/** Whether a continuation holds an encrypted item the provider would refuse as too long. */
export function isOpenAiResponsesContinuationAboveStringLimit(
  providerId: string,
  continuation: ModelProviderContinuation | undefined
): boolean {
  const compactionItem = readOpenAiResponsesCompactionItem(providerId, continuation);
  return (
    (compactionItem !== undefined && isAboveStringLimit(compactionItem)) ||
    readOpenAiResponsesContinuationItems(providerId, continuation).some((entry) =>
      isAboveStringLimit(entry.item)
    )
  );
}

function isAboveStringLimit(item: { encrypted_content: string }): boolean {
  return item.encrypted_content.length > OPENAI_RESPONSES_STRING_MAX_CHARS;
}

/**
 * The newest compaction item of a response. One above the provider's string limit could never be
 * sent back, so the response counts as not compacted and the earlier checkpoint stays in use.
 */
function readLatestCompactionItem(
  output: OpenAiResponsesOutputItem[]
): OpenAiResponsesCompactionItem | undefined {
  const latest = [...output].reverse().find(isOpenAiResponsesCompactionItem);
  return latest && !isAboveStringLimit(latest) ? latest : undefined;
}

function readEncryptedReasoningItems(
  output: OpenAiResponsesOutputItem[]
): OpenAiResponsesContinuationState["encryptedReasoningItems"] {
  const entries: OpenAiResponsesContinuationState["encryptedReasoningItems"] = [];
  output.forEach((item, index) => {
    // A reasoning item above the provider's string limit could never be sent back.
    if (!isOpenAiResponsesReasoningItem(item) || isAboveStringLimit(item)) {
      return;
    }
    const nextToolCall = output
      .slice(index + 1)
      .find(
        (candidate): candidate is Extract<OpenAiResponsesOutputItem, { type: "function_call" }> =>
          candidate.type === "function_call" && typeof candidate.call_id === "string"
      );
    if (nextToolCall) {
      entries.push({
        beforeToolCallId: nextToolCall.call_id,
        item
      });
    }
  });
  return entries;
}

function isOpenAiResponsesReasoningItem(value: unknown): value is OpenAiResponsesReasoningItem {
  return (
    isUnknownRecord(value) &&
    value.type === "reasoning" &&
    typeof value.encrypted_content === "string"
  );
}

function isOpenAiResponsesCompactionItem(value: unknown): value is OpenAiResponsesCompactionItem {
  return (
    isUnknownRecord(value) &&
    value.type === "compaction" &&
    typeof value.id === "string" &&
    typeof value.encrypted_content === "string"
  );
}

export function toOpenAiResponsesTools(
  providerTools: OpenAiCompatibleProviderTool[],
  providerNativeTools: ModelProviderNativeTool[] = []
): OpenAiResponsesTool[] {
  return [
    ...providerTools.map(({ tool, providerName }) => ({
      type: "function" as const,
      name: providerName,
      description: tool.description,
      parameters: tool.inputJsonSchema ?? {
        type: "object",
        additionalProperties: true
      },
      strict: false as const
    })),
    ...providerNativeTools.map(toOpenAiResponsesProviderNativeTool)
  ];
}

export function readOpenAiResponsesText(payload: OpenAiResponsesResponse): string {
  if (payload.output_text) {
    return payload.output_text;
  }
  return (
    payload.output
      ?.filter((item) => item.type === "message")
      .flatMap((item) => ("content" in item && Array.isArray(item.content) ? item.content : []))
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("") ?? ""
  );
}

export function readOpenAiResponsesWebMetadata(payload: OpenAiResponsesResponse): {
  sources: WebSource[];
  citations: MessageCitation[];
} {
  const sourcesById = new Map<string, WebSource>();
  const citations: MessageCitation[] = [];

  for (const item of payload.output ?? []) {
    if (item.type !== "web_search_call" || !isUnknownRecord(item.action)) {
      continue;
    }
    const query = typeof item.action.query === "string" ? item.action.query : undefined;
    const rawSources = Array.isArray(item.action.sources) ? item.action.sources : [];
    rawSources.forEach((candidate, index) => {
      const source = readOpenAiWebSource(candidate, {
        query,
        resultPosition: index + 1
      });
      if (source) {
        sourcesById.set(source.id, {
          ...sourcesById.get(source.id),
          ...source
        });
      }
    });
  }

  for (const item of payload.output ?? []) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (!Array.isArray(part.annotations)) {
        continue;
      }
      for (const annotation of part.annotations) {
        const citationPayload = readUrlCitationPayload(annotation);
        if (!citationPayload) {
          continue;
        }
        const source = readOpenAiWebSource(citationPayload);
        if (!source) {
          continue;
        }
        sourcesById.set(source.id, {
          ...sourcesById.get(source.id),
          ...source
        });
        citations.push({
          sourceId: source.id,
          ...(source.title ? { label: source.title } : {}),
          ...readCitationRange(citationPayload)
        });
      }
    }
  }

  return {
    sources: [...sourcesById.values()],
    citations
  };
}

export function readOpenAiResponsesWebSearchCallCount(payload: OpenAiResponsesResponse): number {
  return payload.output?.filter((item) => item.type === "web_search_call").length ?? 0;
}

export function toProviderToolName(toolName: string): string {
  const providerName = `tool_${Buffer.from(toolName, "utf8").toString("base64url")}`;
  if (providerName.length > 64) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Tool name '${toolName}' is too long for the OpenAI-compatible provider name limit`
    );
  }
  return providerName;
}

/** The product's native tools as the responses format names them. */
const OPENAI_RESPONSES_NATIVE_TOOLS: Record<ModelNativeToolId, OpenAiResponsesTool> = {
  [WEB_SEARCH_MODEL_TOOL_NAME]: { type: "web_search" }
};

function toOpenAiResponsesProviderNativeTool(tool: ModelProviderNativeTool): OpenAiResponsesTool {
  return OPENAI_RESPONSES_NATIVE_TOOLS[tool.name];
}

function readUrlCitationPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isUnknownRecord(value) || value.type !== "url_citation") {
    return undefined;
  }
  if (isUnknownRecord(value.url_citation)) {
    return value.url_citation;
  }
  return value;
}

function readOpenAiWebSource(
  value: unknown,
  defaults: { query?: string; resultPosition?: number } = {}
): WebSource | undefined {
  if (!isUnknownRecord(value) || typeof value.url !== "string" || value.url.length === 0) {
    return undefined;
  }
  const title = typeof value.title === "string" && value.title.length > 0 ? value.title : undefined;
  const snippet =
    typeof value.snippet === "string" && value.snippet.length > 0 ? value.snippet : undefined;
  const query =
    typeof value.query === "string" && value.query.length > 0 ? value.query : defaults.query;
  const resultPosition =
    typeof value.resultPosition === "number" && Number.isInteger(value.resultPosition)
      ? value.resultPosition
      : defaults.resultPosition;
  return {
    id: createWebSourceId(value.url),
    url: value.url,
    provider: "openai-native",
    ...(title ? { title } : {}),
    ...(query ? { query } : {}),
    ...(snippet ? { snippet } : {}),
    ...(resultPosition ? { resultPosition } : {})
  };
}

function readCitationRange(
  value: Record<string, unknown>
): Pick<MessageCitation, "characterRange"> {
  const start =
    typeof value.start_index === "number" && Number.isInteger(value.start_index)
      ? value.start_index
      : undefined;
  const end =
    typeof value.end_index === "number" && Number.isInteger(value.end_index)
      ? value.end_index
      : undefined;
  return start !== undefined && end !== undefined ? { characterRange: { start, end } } : {};
}

function createWebSourceId(url: string): string {
  return `web_${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toOpenAiChatContent(content: ModelContent): OpenAiChatTextImageContent {
  const images = toImageInputs(modelContentImages(content));
  if (images.count === 0) {
    return modelContentText(content);
  }
  const text = withOmittedImagesNote(modelContentText(content), images.omittedCount);
  return [
    ...(text
      ? [
          {
            type: "text" as const,
            text
          }
        ]
      : []),
    ...images.dataUrls.map((url) => ({
      type: "image_url" as const,
      image_url: { url }
    }))
  ];
}

function toOpenAiResponsesContent(content: ModelContent): OpenAiResponsesInputContent {
  const images = toImageInputs(modelContentImages(content));
  if (images.count === 0) {
    return modelContentText(content);
  }
  const text = withOmittedImagesNote(modelContentText(content), images.omittedCount);
  return [
    ...(text
      ? [
          {
            type: "input_text" as const,
            text
          }
        ]
      : []),
    ...images.dataUrls.map((url) => ({
      type: "input_image" as const,
      image_url: url
    }))
  ];
}

/**
 * The data URLs of the images a request can carry. The provider refuses a whole request over one
 * string above its limit, so an image that large is counted as omitted instead of sent.
 */
function toImageInputs(images: Extract<ModelContentPart, { type: "image" }>[]): {
  count: number;
  dataUrls: string[];
  omittedCount: number;
} {
  const dataUrls = images
    .filter((image) => imageDataUrlLength(image) <= OPENAI_RESPONSES_STRING_MAX_CHARS)
    .map(imageToDataUrl);
  return { count: images.length, dataUrls, omittedCount: images.length - dataUrls.length };
}

function withOmittedImagesNote(text: string, omittedCount: number): string {
  if (omittedCount === 0) {
    return text;
  }
  const note =
    omittedCount === 1
      ? "[1 image was too large to include in the model input and was left out.]"
      : `[${omittedCount} images were too large to include in the model input and were left out.]`;
  return text ? `${text}\n\n${note}` : note;
}

function imageDataUrlPrefix(image: Extract<ModelContentPart, { type: "image" }>): string {
  return `data:${image.mimeType};base64,`;
}

function imageDataUrlLength(image: Extract<ModelContentPart, { type: "image" }>): number {
  return imageDataUrlPrefix(image).length + Math.ceil(image.data.byteLength / 3) * 4;
}

function imageToDataUrl(image: Extract<ModelContentPart, { type: "image" }>): string {
  return `${imageDataUrlPrefix(image)}${Buffer.from(image.data).toString("base64")}`;
}

function flushPendingVisualMessages<T>(target: T[], pending: T[]): void {
  if (pending.length === 0) {
    return;
  }
  target.push(...pending.splice(0, pending.length));
}
