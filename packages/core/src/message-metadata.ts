import type { AttachmentManifest } from "./files";
import type { AgentRunId, ToolCallId } from "./ids";
import { isJsonObject, unknownToJsonValue, type JsonObject, type JsonValue } from "./json";
import type { ToolExecutionResult } from "./tool-execution";
import type { MessageCitation, WebSource, WebSourceProvider } from "./web-source";

export const MESSAGE_METADATA_VERSION = 1;

export interface StoredReasoningSummary {
  id: string;
  text: string;
}

export interface StoredToolCall {
  toolCallId: ToolCallId | string;
  toolName: string;
  input: JsonValue;
}

export interface AgentRuntimeUserMessageMetadata {
  version: typeof MESSAGE_METADATA_VERSION;
  kind: "user_message";
  attachmentManifest: JsonValue;
}

export interface AgentRuntimeAssistantToolCallsMetadata {
  version: typeof MESSAGE_METADATA_VERSION;
  kind: "assistant_tool_calls";
  runId: AgentRunId | string;
  toolCalls: StoredToolCall[];
  reasoning?: StoredReasoningSummary[];
}

export interface AgentRuntimeAssistantFinalMetadata {
  version: typeof MESSAGE_METADATA_VERSION;
  kind: "assistant_final";
  runId: AgentRunId | string;
  finishStatus: "completed" | "cancelled";
  cancellationReason?: string;
  reasoning?: StoredReasoningSummary[];
  sources?: WebSource[];
  citations?: MessageCitation[];
}

export interface AgentRuntimeToolResultMetadata {
  version: typeof MESSAGE_METADATA_VERSION;
  kind: "tool_result";
  runId: AgentRunId | string;
  toolCallId: ToolCallId | string;
  toolName: string;
  input: JsonValue;
  result: JsonValue;
  modelOutput: string;
  projectionNotice?: JsonObject;
}

export type AgentRuntimeMessageMetadata =
  | AgentRuntimeUserMessageMetadata
  | AgentRuntimeAssistantToolCallsMetadata
  | AgentRuntimeAssistantFinalMetadata
  | AgentRuntimeToolResultMetadata;

export interface StoredModelOutputProjection {
  text: string;
  notice?: JsonObject;
}

export function createUserMessageMetadata(input: {
  attachmentManifest?: AttachmentManifest;
}): JsonObject | undefined {
  if (!input.attachmentManifest || input.attachmentManifest.attachments.length === 0) {
    return undefined;
  }
  return wrapAgentRuntimeMetadata({
    version: MESSAGE_METADATA_VERSION,
    kind: "user_message",
    attachmentManifest: unknownToJsonValue(input.attachmentManifest)
  });
}

export function createAssistantToolCallsMetadata(input: {
  runId: AgentRunId | string;
  toolCalls: readonly { toolCallId: ToolCallId | string; toolName: string; input: unknown }[];
  reasoning?: readonly StoredReasoningSummary[];
}): JsonObject {
  return wrapAgentRuntimeMetadata({
    version: MESSAGE_METADATA_VERSION,
    kind: "assistant_tool_calls",
    runId: input.runId,
    toolCalls: input.toolCalls.map((toolCall) => ({
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: unknownToJsonValue(toolCall.input)
    })),
    ...createReasoningMetadata(input.reasoning)
  });
}

export function createAssistantFinalMetadata(input: {
  runId: AgentRunId | string;
  reasoning?: readonly StoredReasoningSummary[];
  sources?: readonly WebSource[];
  citations?: readonly MessageCitation[];
  finishStatus?: "completed" | "cancelled";
  cancellationReason?: string;
}): JsonObject {
  return wrapAgentRuntimeMetadata({
    version: MESSAGE_METADATA_VERSION,
    kind: "assistant_final",
    runId: input.runId,
    finishStatus: input.finishStatus ?? "completed",
    ...(input.cancellationReason ? { cancellationReason: input.cancellationReason } : {}),
    ...createReasoningMetadata(input.reasoning),
    ...createWebSourceMetadata(input.sources, input.citations)
  });
}

export function createToolResultMetadata(input: {
  runId: AgentRunId | string;
  toolCall: { toolCallId: ToolCallId | string; toolName: string; input: unknown };
  result: ToolExecutionResult;
  modelOutput: StoredModelOutputProjection;
}): JsonObject {
  return wrapAgentRuntimeMetadata({
    version: MESSAGE_METADATA_VERSION,
    kind: "tool_result",
    runId: input.runId,
    toolCallId: input.toolCall.toolCallId,
    toolName: input.toolCall.toolName,
    input: unknownToJsonValue(input.toolCall.input),
    result: unknownToJsonValue(input.result),
    modelOutput: input.modelOutput.text,
    ...(input.modelOutput.notice ? { projectionNotice: input.modelOutput.notice } : {})
  });
}

export function readAgentRuntimeMessageMetadata(
  metadata: JsonObject | Record<string, unknown> | undefined
): AgentRuntimeMessageMetadata | undefined {
  const runtime = metadata?.agentRuntime;
  if (!isUnknownRecord(runtime) || runtime.version !== MESSAGE_METADATA_VERSION) {
    return undefined;
  }
  if (runtime.kind === "user_message") {
    return {
      version: MESSAGE_METADATA_VERSION,
      kind: "user_message",
      attachmentManifest: unknownToJsonValue(runtime.attachmentManifest)
    };
  }
  if (runtime.kind === "assistant_tool_calls" && typeof runtime.runId === "string") {
    return {
      version: MESSAGE_METADATA_VERSION,
      kind: "assistant_tool_calls",
      runId: runtime.runId,
      toolCalls: readStoredToolCalls(runtime.toolCalls),
      ...readReasoningMetadata(runtime.reasoning)
    };
  }
  if (runtime.kind === "assistant_final" && typeof runtime.runId === "string") {
    return {
      version: MESSAGE_METADATA_VERSION,
      kind: "assistant_final",
      runId: runtime.runId,
      finishStatus: runtime.finishStatus === "cancelled" ? "cancelled" : "completed",
      ...(typeof runtime.cancellationReason === "string"
        ? { cancellationReason: runtime.cancellationReason }
        : {}),
      ...readReasoningMetadata(runtime.reasoning),
      ...readWebSourceMetadata(runtime.sources, runtime.citations)
    };
  }
  if (
    runtime.kind === "tool_result" &&
    typeof runtime.runId === "string" &&
    typeof runtime.toolCallId === "string" &&
    typeof runtime.toolName === "string"
  ) {
    const rawProjectionNotice = unknownToJsonValue(runtime.projectionNotice);
    const projectionNotice = isJsonObject(rawProjectionNotice) ? rawProjectionNotice : undefined;
    return {
      version: MESSAGE_METADATA_VERSION,
      kind: "tool_result",
      runId: runtime.runId,
      toolCallId: runtime.toolCallId,
      toolName: runtime.toolName,
      input: unknownToJsonValue(runtime.input),
      result: unknownToJsonValue(runtime.result),
      modelOutput: typeof runtime.modelOutput === "string" ? runtime.modelOutput : "",
      ...(projectionNotice ? { projectionNotice } : {})
    };
  }
  return undefined;
}

export function readUserMessageMetadata(
  metadata: JsonObject | Record<string, unknown> | undefined
): AgentRuntimeUserMessageMetadata | undefined {
  const runtime = readAgentRuntimeMessageMetadata(metadata);
  return runtime?.kind === "user_message" ? runtime : undefined;
}

export function readAssistantToolCallsMetadata(
  metadata: JsonObject | Record<string, unknown> | undefined
): AgentRuntimeAssistantToolCallsMetadata | undefined {
  const runtime = readAgentRuntimeMessageMetadata(metadata);
  return runtime?.kind === "assistant_tool_calls" ? runtime : undefined;
}

export function readAssistantFinalMetadata(
  metadata: JsonObject | Record<string, unknown> | undefined
): AgentRuntimeAssistantFinalMetadata | undefined {
  const runtime = readAgentRuntimeMessageMetadata(metadata);
  return runtime?.kind === "assistant_final" ? runtime : undefined;
}

export function readToolResultMetadata(
  metadata: JsonObject | Record<string, unknown> | undefined
): AgentRuntimeToolResultMetadata | undefined {
  const runtime = readAgentRuntimeMessageMetadata(metadata);
  return runtime?.kind === "tool_result" ? runtime : undefined;
}

export function readAssistantReasoningSummaries(
  metadata: JsonObject | Record<string, unknown> | undefined
): StoredReasoningSummary[] {
  const runtime = readAgentRuntimeMessageMetadata(metadata);
  return runtime?.kind === "assistant_tool_calls" || runtime?.kind === "assistant_final"
    ? runtime.reasoning ?? []
    : [];
}

export function readAssistantWebSourceMetadata(
  metadata: JsonObject | Record<string, unknown> | undefined
): { sources: WebSource[]; citations: MessageCitation[] } {
  const runtime = readAgentRuntimeMessageMetadata(metadata);
  return runtime?.kind === "assistant_final"
    ? {
        sources: runtime.sources ?? [],
        citations: runtime.citations ?? []
      }
    : { sources: [], citations: [] };
}

function wrapAgentRuntimeMetadata(runtime: AgentRuntimeMessageMetadata): JsonObject {
  return {
    agentRuntime: unknownToJsonValue(runtime) as JsonObject
  };
}

function createReasoningMetadata(
  reasoning: readonly StoredReasoningSummary[] | undefined
): { reasoning?: StoredReasoningSummary[] } {
  const summaries = reasoning?.filter((summary) => summary.text.length > 0) ?? [];
  return summaries.length > 0 ? { reasoning: [...summaries] } : {};
}

function createWebSourceMetadata(
  sources: readonly WebSource[] | undefined,
  citations: readonly MessageCitation[] | undefined
): { sources?: WebSource[]; citations?: MessageCitation[] } {
  const activeSources = sources?.filter((source) => source.id.length > 0 && source.url.length > 0) ?? [];
  const activeCitations = citations?.filter((citation) => citation.sourceId.length > 0) ?? [];
  return {
    ...(activeSources.length > 0 ? { sources: [...activeSources] } : {}),
    ...(activeCitations.length > 0 ? { citations: [...activeCitations] } : {})
  };
}

function readStoredToolCalls(value: unknown): StoredToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate): StoredToolCall[] => {
    if (!isUnknownRecord(candidate)) {
      return [];
    }
    const toolCallId = typeof candidate.toolCallId === "string" ? candidate.toolCallId : undefined;
    const toolName = typeof candidate.toolName === "string" ? candidate.toolName : undefined;
    if (!toolCallId || !toolName) {
      return [];
    }
    return [
      {
        toolCallId,
        toolName,
        input: unknownToJsonValue(candidate.input)
      }
    ];
  });
}

function readReasoningMetadata(value: unknown): { reasoning?: StoredReasoningSummary[] } {
  if (!Array.isArray(value)) {
    return {};
  }
  const reasoning = value.flatMap((candidate): StoredReasoningSummary[] => {
    if (!isUnknownRecord(candidate)) {
      return [];
    }
    const id = typeof candidate.id === "string" ? candidate.id : undefined;
    const text = typeof candidate.text === "string" ? candidate.text : undefined;
    return id && text ? [{ id, text }] : [];
  });
  return reasoning.length > 0 ? { reasoning } : {};
}

function readWebSourceMetadata(
  sourceValue: unknown,
  citationValue: unknown
): { sources?: WebSource[]; citations?: MessageCitation[] } {
  const sources = readWebSources(sourceValue);
  const citations = readMessageCitations(citationValue);
  return {
    ...(sources.length > 0 ? { sources } : {}),
    ...(citations.length > 0 ? { citations } : {})
  };
}

function readWebSources(value: unknown): WebSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate): WebSource[] => {
    if (!isUnknownRecord(candidate)) {
      return [];
    }
    const id = typeof candidate.id === "string" ? candidate.id : undefined;
    const url = typeof candidate.url === "string" ? candidate.url : undefined;
    const provider =
      typeof candidate.provider === "string" && isWebSourceProvider(candidate.provider)
        ? candidate.provider
        : undefined;
    if (!id || !url || !provider) {
      return [];
    }
    return [
      {
        id,
        url,
        provider,
        ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
        ...(typeof candidate.query === "string" ? { query: candidate.query } : {}),
        ...(typeof candidate.retrievedAt === "string" ? { retrievedAt: candidate.retrievedAt } : {}),
        ...(typeof candidate.snippet === "string" ? { snippet: candidate.snippet } : {}),
        ...(typeof candidate.contentHash === "string" ? { contentHash: candidate.contentHash } : {}),
        ...(typeof candidate.resultPosition === "number"
          ? { resultPosition: candidate.resultPosition }
          : {})
      }
    ];
  });
}

function readMessageCitations(value: unknown): MessageCitation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate): MessageCitation[] => {
    if (!isUnknownRecord(candidate) || typeof candidate.sourceId !== "string") {
      return [];
    }
    const characterRange = readCitationCharacterRange(candidate.characterRange);
    return [
      {
        sourceId: candidate.sourceId,
        ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
        ...(typeof candidate.quote === "string" ? { quote: candidate.quote } : {}),
        ...(characterRange ? { characterRange } : {})
      }
    ];
  });
}

function readCitationCharacterRange(value: unknown): MessageCitation["characterRange"] | undefined {
  if (!isUnknownRecord(value)) {
    return undefined;
  }
  const start = typeof value.start === "number" && Number.isInteger(value.start) ? value.start : undefined;
  const end = typeof value.end === "number" && Number.isInteger(value.end) ? value.end : undefined;
  return start !== undefined && end !== undefined ? { start, end } : undefined;
}

function isWebSourceProvider(value: string): value is WebSourceProvider {
  return (
    value === "openai-native" ||
    value === "serper" ||
    value === "tavily" ||
    value === "firecrawl" ||
    value === "browserbase" ||
    value === "direct"
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
