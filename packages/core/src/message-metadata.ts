import type { ApprovalRequest, ApprovalRequestStatus } from "./approval-requests";
import type { CreateMessageInput } from "./conversation";
import { asMessageId } from "./ids";
import type { AttachmentManifest } from "./files";
import type { AgentRunId, MessageId, ToolCallId } from "./ids";
import { isJsonObject, unknownToJsonValue, type JsonObject, type JsonValue } from "./json";
import type { ToolExecutionResult } from "./tool-execution";
import type { MessageCitation, WebSource, WebSourceProvider } from "./web-source";

export const MESSAGE_METADATA_VERSION = 1;

export interface StoredReasoningSummary {
  id: string;
  text: string;
}

export interface StoredModelContextSnapshot {
  inputTokens: number;
  compactThresholdTokens: number;
  compacted: boolean;
}

export interface StoredModelProviderContinuation {
  providerId: string;
  state: JsonValue;
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
  modelContext?: StoredModelContextSnapshot;
  providerContinuation?: StoredModelProviderContinuation;
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
  modelContext?: StoredModelContextSnapshot;
  providerContinuation?: StoredModelProviderContinuation;
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

export interface ApprovalDecisionMessageMetadata {
  version: typeof MESSAGE_METADATA_VERSION;
  kind: "approval_decision";
  requestId: string;
  requestKind: string;
  status: Exclude<ApprovalRequestStatus, "pending">;
  decidedBy: string;
  decidedByLabel: string;
  decidedAt: string;
  summary: string;
  comment?: string;
  /** User id of the requester. Absent on decisions stored before it was recorded. */
  requestedBy?: string;
}

/** No payload, apply result, or skill text crosses this boundary. */
export function createApprovalDecisionMessage(
  request: ApprovalRequest
): (CreateMessageInput & { id: MessageId }) | undefined {
  if (!request.origin || request.status === "pending") {
    return undefined;
  }
  const reversion = request.status === "reverted" ? request.reversion : undefined;
  const event: ApprovalDecisionMessageMetadata = {
    version: MESSAGE_METADATA_VERSION,
    kind: "approval_decision",
    requestId: request.id,
    requestKind: request.kind,
    status: request.status,
    decidedBy: reversion?.revertedBy ?? request.decision?.decidedBy ?? request.requestedBy.id,
    decidedByLabel:
      reversion?.revertedByLabel ??
      request.decision?.decidedByLabel ??
      request.requestedBy.displayLabel,
    decidedAt: reversion?.revertedAt ?? request.decision?.decidedAt ?? request.updatedAt,
    summary: request.summary,
    ...(request.status !== "reverted" && request.decision?.comment
      ? { comment: request.decision.comment }
      : {}),
    requestedBy: request.requestedBy.id
  };
  return {
    id: asMessageId(`msg_${request.id}_${request.status}`),
    clientInstanceId: request.clientInstanceId,
    conversationId: request.origin.conversationId,
    role: "system",
    text: approvalDecisionNote(event),
    metadata: wrapAgentRuntimeMetadata(event)
  };
}

/**
 * Whoever requests changes on someone else's proposal also revises it, in a
 * conversation of their own: a revision never goes back to a requester who may
 * not approve. Only a requester deciding on their own proposal revises it where
 * it came from. A decision stored without its requester keeps that reading.
 */
export function approvalRevisionOwner(
  event: Pick<ApprovalDecisionMessageMetadata, "status" | "decidedBy" | "requestedBy">
): "requester" | "reviewer" | undefined {
  if (event.status !== "changes_requested") {
    return undefined;
  }
  return event.requestedBy !== undefined && event.requestedBy !== event.decidedBy
    ? "reviewer"
    : "requester";
}

export function approvalDecisionNote(event: ApprovalDecisionMessageMetadata): string {
  const revisionOwner = approvalRevisionOwner(event);
  const outcome =
    event.status === "approved"
      ? " The change is now active."
      : revisionOwner === "reviewer"
        ? " The reviewer has taken over the revision and submits the revised proposal themselves. Do NOT submit a revised proposal in this conversation unless the user explicitly asks for one."
        : revisionOwner === "requester"
          ? " When the user continues, submit a revised proposal addressing the requested changes."
          : event.status === "reverted"
            ? " The approved change has been reverted."
            : "";
  return `Approval request ${event.requestId} (${event.requestKind}: ${JSON.stringify(event.summary)}) was ${event.status} by ${JSON.stringify(event.decidedByLabel)} at ${event.decidedAt}.${outcome}${event.comment ? ` Comment: ${JSON.stringify(event.comment)}` : ""}`;
}

export function readApprovalDecisionMetadata(
  metadata: JsonObject | Record<string, unknown> | undefined
): ApprovalDecisionMessageMetadata | undefined {
  const runtime = readAgentRuntimeMessageMetadata(metadata);
  return runtime?.kind === "approval_decision" ? runtime : undefined;
}

export type AgentRuntimeMessageMetadata =
  | ApprovalDecisionMessageMetadata
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
  modelContext?: StoredModelContextSnapshot;
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
    ...createReasoningMetadata(input.reasoning),
    ...(input.modelContext ? { modelContext: input.modelContext } : {})
  });
}

export function createAssistantFinalMetadata(input: {
  runId: AgentRunId | string;
  reasoning?: readonly StoredReasoningSummary[];
  sources?: readonly WebSource[];
  citations?: readonly MessageCitation[];
  finishStatus?: "completed" | "cancelled";
  cancellationReason?: string;
  modelContext?: StoredModelContextSnapshot;
}): JsonObject {
  return wrapAgentRuntimeMetadata({
    version: MESSAGE_METADATA_VERSION,
    kind: "assistant_final",
    runId: input.runId,
    finishStatus: input.finishStatus ?? "completed",
    ...(input.cancellationReason ? { cancellationReason: input.cancellationReason } : {}),
    ...createReasoningMetadata(input.reasoning),
    ...createWebSourceMetadata(input.sources, input.citations),
    ...(input.modelContext ? { modelContext: input.modelContext } : {})
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
  if (
    runtime.kind === "approval_decision" &&
    typeof runtime.requestId === "string" &&
    typeof runtime.requestKind === "string" &&
    typeof runtime.decidedBy === "string" &&
    typeof runtime.decidedByLabel === "string" &&
    typeof runtime.decidedAt === "string" &&
    typeof runtime.summary === "string" &&
    (runtime.status === "approved" ||
      runtime.status === "rejected" ||
      runtime.status === "changes_requested" ||
      runtime.status === "superseded" ||
      runtime.status === "withdrawn" ||
      runtime.status === "reverted")
  ) {
    return {
      version: MESSAGE_METADATA_VERSION,
      kind: "approval_decision",
      requestId: runtime.requestId,
      requestKind: runtime.requestKind,
      status: runtime.status,
      decidedBy: runtime.decidedBy,
      decidedByLabel: runtime.decidedByLabel,
      decidedAt: runtime.decidedAt,
      summary: runtime.summary,
      ...(typeof runtime.comment === "string" ? { comment: runtime.comment } : {}),
      ...(typeof runtime.requestedBy === "string" ? { requestedBy: runtime.requestedBy } : {})
    };
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
      ...readReasoningMetadata(runtime.reasoning),
      ...readModelContextMetadata(runtime.modelContext),
      ...readProviderContinuationMetadata(runtime.providerContinuation)
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
      ...readWebSourceMetadata(runtime.sources, runtime.citations),
      ...readModelContextMetadata(runtime.modelContext),
      ...readProviderContinuationMetadata(runtime.providerContinuation)
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
    ? (runtime.reasoning ?? [])
    : [];
}

export function readAssistantModelContextSnapshot(
  metadata: JsonObject | Record<string, unknown> | undefined
): StoredModelContextSnapshot | undefined {
  const runtime = readAgentRuntimeMessageMetadata(metadata);
  return runtime?.kind === "assistant_tool_calls" || runtime?.kind === "assistant_final"
    ? runtime.modelContext
    : undefined;
}

export function readAssistantProviderContinuation(
  metadata: JsonObject | Record<string, unknown> | undefined
): StoredModelProviderContinuation | undefined {
  const runtime = readAgentRuntimeMessageMetadata(metadata);
  return runtime?.kind === "assistant_tool_calls" || runtime?.kind === "assistant_final"
    ? runtime.providerContinuation
    : undefined;
}

export function withoutAssistantProviderContinuation(
  metadata: JsonObject | undefined
): JsonObject | undefined {
  const runtime = metadata?.agentRuntime;
  if (!isUnknownRecord(runtime) || !("providerContinuation" in runtime)) {
    return metadata;
  }
  const { providerContinuation: _providerContinuation, ...publicRuntime } = runtime;
  return {
    ...metadata,
    agentRuntime: unknownToJsonValue(publicRuntime) as JsonObject
  };
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

function createReasoningMetadata(reasoning: readonly StoredReasoningSummary[] | undefined): {
  reasoning?: StoredReasoningSummary[];
} {
  const summaries = reasoning?.filter((summary) => summary.text.length > 0) ?? [];
  return summaries.length > 0 ? { reasoning: [...summaries] } : {};
}

function createWebSourceMetadata(
  sources: readonly WebSource[] | undefined,
  citations: readonly MessageCitation[] | undefined
): { sources?: WebSource[]; citations?: MessageCitation[] } {
  const activeSources =
    sources?.filter((source) => source.id.length > 0 && source.url.length > 0) ?? [];
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

function readModelContextMetadata(value: unknown): { modelContext?: StoredModelContextSnapshot } {
  if (
    !isUnknownRecord(value) ||
    typeof value.inputTokens !== "number" ||
    !Number.isFinite(value.inputTokens) ||
    typeof value.compactThresholdTokens !== "number" ||
    !Number.isFinite(value.compactThresholdTokens) ||
    typeof value.compacted !== "boolean"
  ) {
    return {};
  }
  return {
    modelContext: {
      inputTokens: Math.max(0, Math.trunc(value.inputTokens)),
      compactThresholdTokens: Math.max(1, Math.trunc(value.compactThresholdTokens)),
      compacted: value.compacted
    }
  };
}

function readProviderContinuationMetadata(value: unknown): {
  providerContinuation?: StoredModelProviderContinuation;
} {
  if (!isUnknownRecord(value) || typeof value.providerId !== "string") {
    return {};
  }
  return {
    providerContinuation: {
      providerId: value.providerId,
      state: unknownToJsonValue(value.state)
    }
  };
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
        ...(typeof candidate.retrievedAt === "string"
          ? { retrievedAt: candidate.retrievedAt }
          : {}),
        ...(typeof candidate.snippet === "string" ? { snippet: candidate.snippet } : {}),
        ...(typeof candidate.contentHash === "string"
          ? { contentHash: candidate.contentHash }
          : {}),
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
  const start =
    typeof value.start === "number" && Number.isInteger(value.start) ? value.start : undefined;
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
