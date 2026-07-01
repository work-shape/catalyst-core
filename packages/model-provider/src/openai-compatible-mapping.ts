import { createHash } from "node:crypto";
import {
  AppError,
  type MessageCitation,
  type ModelTokenUsage,
  type WebSource
} from "@vivd-catalyst/core";
import {
  OPENAI_WEB_SEARCH_PROVIDER_TOOL_ID,
  isModelFunctionTool,
  isModelProviderNativeTool,
  modelContentImages,
  modelContentText,
  type ModelContent,
  type ModelContentPart,
  type ModelFunctionTool,
  type ModelMessage,
  type ModelProviderNativeTool,
  type ModelTool
} from "./types";
import { serializeToolInput } from "./tool-input";
import type {
  OpenAiCompatibleMessage,
  OpenAiCompatibleResponse,
  OpenAiResponseInput,
  OpenAiResponseInputItem,
  OpenAiResponsesInputContent,
  OpenAiResponsesResponse,
  OpenAiResponsesTool,
  OpenAiResponsesUsage
} from "./openai-compatible-types";

export interface OpenAiCompatibleProviderTool {
  tool: ModelFunctionTool;
  providerName: string;
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

export function toModelUsage(usage: OpenAiCompatibleResponse["usage"]): ModelTokenUsage & {
  webSearchCallCount: number;
} {
  if (!usage) {
    return noReportedUsage();
  }

  return {
    inputTokens: usage.prompt_tokens,
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
    const images = modelContentImages(message.content);
    if (images.length > 0) {
      pendingVisualMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Visual output from tool call ${message.toolCallId}.`
          },
          ...images.map((image) => ({
            type: "image_url" as const,
            image_url: {
              url: imageToDataUrl(image)
            }
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

export function toOpenAiResponsesInput(messages: ModelMessage[]): OpenAiResponseInput {
  const input: OpenAiResponseInput = [];
  const pendingVisualMessages: OpenAiResponseInputItem[] = [];
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
      const images = modelContentImages(message.content);
      if (images.length > 0) {
        pendingVisualMessages.push({
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Visual output from tool call ${message.toolCallId}.`
            },
            ...images.map((image) => ({
              type: "input_image" as const,
              image_url: imageToDataUrl(image)
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
  return input;
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

function toOpenAiResponsesProviderNativeTool(tool: ModelProviderNativeTool): OpenAiResponsesTool {
  if (tool.id === OPENAI_WEB_SEARCH_PROVIDER_TOOL_ID) {
    return {
      type: "web_search"
    };
  }
  throw new AppError("VALIDATION_FAILED", `Unsupported provider-native model tool '${tool.id}'`);
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
  const snippet = typeof value.snippet === "string" && value.snippet.length > 0 ? value.snippet : undefined;
  const query = typeof value.query === "string" && value.query.length > 0 ? value.query : defaults.query;
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

function readCitationRange(value: Record<string, unknown>): Pick<MessageCitation, "characterRange"> {
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
  const images = modelContentImages(content);
  if (images.length === 0) {
    return modelContentText(content);
  }
  const text = modelContentText(content);
  return [
    ...(text
      ? [
          {
            type: "text" as const,
            text
          }
        ]
      : []),
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: {
        url: imageToDataUrl(image)
      }
    }))
  ];
}

function toOpenAiResponsesContent(content: ModelContent): OpenAiResponsesInputContent {
  const images = modelContentImages(content);
  if (images.length === 0) {
    return modelContentText(content);
  }
  const text = modelContentText(content);
  return [
    ...(text
      ? [
          {
            type: "input_text" as const,
            text
          }
        ]
      : []),
    ...images.map((image) => ({
      type: "input_image" as const,
      image_url: imageToDataUrl(image)
    }))
  ];
}

function imageToDataUrl(image: Extract<ModelContentPart, { type: "image" }>): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`;
}

function flushPendingVisualMessages<T>(target: T[], pending: T[]): void {
  if (pending.length === 0) {
    return;
  }
  target.push(...pending.splice(0, pending.length));
}
