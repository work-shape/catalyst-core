import type { AgentRunProjection, DraftAttachment, Message } from "@work-shape/catalyst-api-client";
import {
  isJsonObject,
  unknownToJsonValue,
  type JsonObject,
  type MessageCitation,
  type WebSource
} from "@work-shape/catalyst-core";
import type { UIMessage } from "ai";
import {
  WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE,
  createWorkspacePromotedArtifactsData,
  dedupeToolArtifactRefs,
  readSurfacedToolArtifactRefs,
  type ToolArtifactDownloadRef
} from "../tools/tool-artifacts";
import {
  WORKSPACE_PROMOTED_SURFACES_DATA_TYPE,
  createWorkspacePromotedSurfacesData,
  dedupeToolSurfaceRefs,
  readToolSurfaceRefs,
  type ToolSurfaceRef
} from "../tools/tool-surfaces";
import { readWorkspaceToolErrorText } from "../tools/workspace-tool-display";
import {
  readCompatibleAssistantFinalRunId,
  readCompatibleAssistantKnowledgeSources,
  readCompatibleAssistantToolCalls,
  readCompatibleAssistantWebSourceMetadata,
  readCompatibleUserAttachmentRefs,
  type PersistedToolResult
} from "./assistant-message-compat";
import type { AssistantUiActiveRun, AssistantUiMessageMetadata } from "./assistant-ui-types";

interface UiMessagePartProjectionOptions {
  includeSyntheticWebSearchTool?: boolean;
}

export function toAttachmentFilePart(
  attachment: Pick<DraftAttachment, "fileId" | "filename" | "mimeType">
): UIMessage["parts"][number] {
  return {
    type: "file",
    mediaType: attachment.mimeType ?? "application/octet-stream",
    filename: attachment.filename,
    url: `vivd-file://${encodeURIComponent(attachment.fileId)}`
  };
}

/** One piece of a run as the thread shows it: an answer, or a message steered into it. */
export type ProjectionSegment =
  | { kind: "answer"; projection: AgentRunProjection }
  | { kind: "steer"; messageId: string; text: string };

/**
 * A run's projection cut at the messages its person steered into it (FU-2): the answer before
 * a steer, the steer, and the answer after it, in the order the run took them. Each answer
 * holds only its own parts. An earlier answer is done; the last one carries the run's state.
 * A run without a steer is one answer, unchanged.
 */
export function splitProjectionAtSteers(projection: AgentRunProjection): ProjectionSegment[] {
  const parts = projection.parts ?? [];
  if (!parts.some((part) => part.type === "user_message")) {
    return [{ kind: "answer", projection }];
  }
  const segments: ProjectionSegment[] = [];
  let current: AgentRunProjection["parts"] = [];
  const answer = (answerParts: AgentRunProjection["parts"], last: boolean): ProjectionSegment => ({
    kind: "answer",
    projection: {
      ...projection,
      ...(last ? {} : { status: "completed" as const, preparingTool: undefined }),
      parts: answerParts,
      text: answerParts.map((part) => (part.type === "text" ? part.text : "")).join(""),
      reasoning: [],
      activeToolCalls: []
    }
  });
  for (const part of parts) {
    if (part.type !== "user_message") {
      current.push(part);
      continue;
    }
    if (current.length > 0) segments.push(answer(current, false));
    segments.push({ kind: "steer", messageId: part.messageId, text: part.text });
    current = [];
  }
  // The last answer stays, empty or not: the run goes on in it.
  segments.push(answer(current, true));
  return segments;
}

/** The steered message as the thread shows it, between the answers of its run. */
export function toSteeredUiMessage(segment: { messageId: string; text: string }): UIMessage {
  return {
    id: segment.messageId,
    role: "user",
    parts: [{ type: "text", text: segment.text, state: "done" }]
  };
}

/**
 * The active run as the thread shows it: one assistant message, or, where its person steered
 * it, its answers with the steered messages between them. The last answer keeps the run's id.
 */
export function toActiveRunUiMessages(activeRun: AssistantUiActiveRun): UIMessage[] {
  const segments = splitProjectionAtSteers(activeRun.projection);
  return segments.map((segment, index): UIMessage => {
    if (segment.kind === "steer") return toSteeredUiMessage(segment);
    if (index === segments.length - 1) {
      return toActiveRunUiMessage(activeRun, segment.projection);
    }
    return {
      id: `${activeRun.run.id}:${index}`,
      role: "assistant",
      parts: toProjectionUiMessageParts(segment.projection, activeRun)
    };
  });
}

/**
 * The active run's assistant message. `shown` is the part of the run it shows, the last answer
 * of a steered run; what the run surfaced is read from all of it.
 */
function toActiveRunUiMessage(
  activeRun: AssistantUiActiveRun,
  shown: AgentRunProjection = activeRun.projection
): UIMessage {
  const parts = toProjectionUiMessageParts(shown, activeRun);
  if (isTerminalRunStatus(activeRun.projection.status)) {
    appendWorkspacePromotedSurfacesPart(
      parts,
      activeRun.projection.parts.flatMap((part): ToolSurfaceRef[] =>
        part.type === "tool_call"
          ? readToolSurfaceRefs(part.output, {
              toolCallId: part.toolCallId,
              toolName: part.toolName
            })
          : []
      )
    );
    appendWorkspacePromotedArtifactsPart(
      parts,
      activeRun.projection.parts.flatMap((part): ToolArtifactDownloadRef[] =>
        part.type === "tool_call" ? readSurfacedToolArtifactRefs(part.output, part.toolName) : []
      )
    );
  }

  return {
    id: activeRun.run.id,
    role: "assistant",
    metadata: {
      custom: {
        source: "active-run",
        ...(activeRun.projection.status === "completed" ? { activeRunCompleted: true } : {})
      }
    } satisfies AssistantUiMessageMetadata,
    parts
  };
}

function isTerminalRunStatus(status: AgentRunProjection["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

export function toProjectionUiMessageParts(
  projection: AgentRunProjection,
  activeRun?: AssistantUiActiveRun
): UIMessage["parts"] {
  const terminal =
    projection.status === "completed" ||
    projection.status === "cancelled" ||
    projection.status === "failed";
  const projectionParts = projection.parts ?? [];
  const orderedParts =
    projectionParts.length > 0 ? projectionParts : legacyActiveRunParts(projection);
  const displayParts = activeRunPartsWithTextFallback(orderedParts, projection.text);
  const parts = displayParts.flatMap((part, index): UIMessage["parts"] => {
    if (part.type === "text") {
      if (part.text.trim().length === 0 && displayParts.length > 1) {
        return [];
      }
      return [
        {
          type: "text",
          text: part.text,
          state: !terminal && index === displayParts.length - 1 ? "streaming" : "done"
        } as UIMessage["parts"][number]
      ];
    }
    if (part.type === "reasoning") {
      if (!part.text.trim() && !part.open) {
        return [];
      }
      return [
        {
          type: "reasoning",
          text: part.text,
          state: part.open && !terminal ? "streaming" : "done"
        } as UIMessage["parts"][number]
      ];
    }
    // A steer is its own user message: `splitProjectionAtSteers` cuts the run at it.
    if (part.type === "user_message") {
      return [];
    }
    return [toToolCallUiPart(part, activeRun)];
  });

  if (parts.length === 0) {
    parts.push({
      type: "text",
      text: "",
      state: terminal ? "done" : "streaming"
    } as UIMessage["parts"][number]);
  }

  return parts;
}

function activeRunPartsWithTextFallback(
  parts: AgentRunProjection["parts"],
  text: string
): AgentRunProjection["parts"] {
  if (!text.trim() || parts.some((part) => part.type === "text" && part.text.trim().length > 0)) {
    return parts;
  }
  return [
    ...parts,
    {
      type: "text",
      text
    }
  ];
}

function legacyActiveRunParts(projection: AgentRunProjection): AgentRunProjection["parts"] {
  const parts: AgentRunProjection["parts"] = [
    ...projection.reasoning.map((entry) => ({
      type: "reasoning" as const,
      id: entry.id,
      text: entry.text,
      open: entry.open
    })),
    ...projection.activeToolCalls.map((entry) => ({
      type: "tool_call" as const,
      ...entry
    }))
  ];
  if (projection.text.trim().length > 0 || parts.length === 0) {
    parts.push({
      type: "text",
      text: projection.text
    });
  }
  return parts;
}

function toToolCallUiPart(
  toolCall: Extract<AgentRunProjection["parts"][number], { type: "tool_call" }>,
  activeRun?: AssistantUiActiveRun
): UIMessage["parts"][number] {
  const terminalToolError = terminalToolErrorForActiveRun(toolCall, activeRun);
  const workspaceToolError = readWorkspaceToolErrorText({
    result: toolCall.output,
    toolName: toolCall.toolName
  });
  const projectedErrorText = terminalToolError ?? workspaceToolError;
  return {
    type: "dynamic-tool",
    toolName: toolCall.toolName,
    toolCallId: toolCall.toolCallId,
    title: toolCall.toolName,
    state: toAssistantToolState(toolCall.state),
    input: toolCall.input,
    ...(projectedErrorText
      ? {
          state: "output-error",
          errorText: projectedErrorText,
          ...(toolCall.output !== undefined ? { output: toolCall.output } : {})
        }
      : toolCall.state === "output_error" && toolCall.connect
        ? connectRefusalPart({ status: "failed", connect: toolCall.connect })
        : toolCall.state === "output_error"
          ? {
              state: "output-error",
              errorText: toolCall.errorText ?? "Tool call failed",
              ...(toolCall.output !== undefined ? { output: toolCall.output } : {})
            }
          : toolCall.state === "output_available"
            ? { output: toolCall.output }
            : {})
  } as UIMessage["parts"][number];
}

function terminalToolErrorForActiveRun(
  toolCall: Extract<AgentRunProjection["parts"][number], { type: "tool_call" }>,
  activeRun: AssistantUiActiveRun | undefined
): string | undefined {
  if (!activeRun || toolCall.state === "output_available" || toolCall.state === "output_error") {
    return undefined;
  }
  if (activeRun.run.status === "failed") {
    return activeRun.projection.error?.message ?? "Run failed";
  }
  if (activeRun.run.status === "cancelled") {
    return "Run cancelled";
  }
  return undefined;
}

/**
 * A call of a personal Connection refused for a missing sign-in (CHAT-CONN-2b). Its part carries
 * the refusal as its output: an errored part keeps only the error text, and the Connect card that
 * stands in place of the error reads what to connect from the output.
 */
function connectRefusalPart(output: Record<string, unknown>) {
  return { state: "output-available", output } as const;
}

function isConnectRefusalOutput(output: unknown): output is Record<string, unknown> {
  return (
    typeof output === "object" && output !== null && "connect" in output && output.connect != null
  );
}

function toAssistantToolState(
  state: AgentRunProjection["activeToolCalls"][number]["state"]
): string {
  if (state === "output_available") {
    return "output-available";
  }
  if (state === "output_error") {
    return "output-error";
  }
  return "input-available";
}

export function toUiMessageParts(
  message: Message,
  toolResultsByToolCallId: Map<string, PersistedToolResult>,
  surfacedArtifactsByRunId: Map<string, ToolArtifactDownloadRef[]>,
  surfacedSurfacesByRunId: Map<string, ToolSurfaceRef[]>,
  options: UiMessagePartProjectionOptions = {}
): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];
  const toolCalls = readCompatibleAssistantToolCalls(message);
  if (message.text || message.role !== "assistant") {
    parts.push({
      type: "text",
      text: message.text,
      state: "done"
    });
  }
  if (message.role === "user") {
    parts.push(...readUserAttachmentFileParts(message));
  }

  for (const toolCall of toolCalls) {
    const toolResult = toolResultsByToolCallId.get(toolCall.toolCallId);
    const workspaceToolError = toolResult
      ? readWorkspaceToolErrorText({ result: toolResult.output, toolName: toolCall.toolName })
      : undefined;
    const projectedErrorText =
      toolResult?.status === "failed" ? toolResult.errorText : workspaceToolError;
    const connectOutput =
      toolResult?.status === "failed" && isConnectRefusalOutput(toolResult.output)
        ? toolResult.output
        : undefined;
    parts.push({
      type: "dynamic-tool",
      toolName: toolCall.toolName,
      toolCallId: toolCall.toolCallId,
      title: toolCall.toolName,
      state: projectedErrorText
        ? "output-error"
        : toolResult
          ? "output-available"
          : "input-available",
      input: toolCall.input,
      ...(connectOutput
        ? connectRefusalPart(connectOutput)
        : projectedErrorText
          ? {
              errorText: projectedErrorText,
              ...(toolResult?.output !== undefined ? { output: toolResult.output } : {})
            }
          : toolResult
            ? { output: toolResult.output }
            : {})
    } as UIMessage["parts"][number]);
  }

  const display = message.metadata?.display;
  if (display !== undefined) {
    parts.push({
      type: "data-display",
      data: display
    } as UIMessage["parts"][number]);
  }
  appendAssistantWebSourceParts(parts, message, {
    includeSyntheticTool:
      options.includeSyntheticWebSearchTool !== false &&
      !toolCalls.some((toolCall) => toolCall.toolName === "web_search")
  });
  appendAssistantKnowledgeSourceParts(parts, message);
  const finalRunId = readCompatibleAssistantFinalRunId(message);
  appendWorkspacePromotedSurfacesPart(
    parts,
    finalRunId ? (surfacedSurfacesByRunId.get(finalRunId) ?? []) : []
  );
  appendWorkspacePromotedArtifactsPart(
    parts,
    finalRunId ? (surfacedArtifactsByRunId.get(finalRunId) ?? []) : []
  );
  return parts.length > 0
    ? parts
    : [
        {
          type: "text",
          text: "",
          state: "done"
        }
      ];
}

export function appendWorkspacePromotedSurfacesPart(
  parts: UIMessage["parts"],
  surfaces: ToolSurfaceRef[]
): void {
  const uniqueSurfaces = dedupeToolSurfaceRefs(surfaces);
  if (uniqueSurfaces.length === 0) {
    return;
  }
  parts.push({
    type: WORKSPACE_PROMOTED_SURFACES_DATA_TYPE,
    data: createWorkspacePromotedSurfacesData(uniqueSurfaces)
  } as UIMessage["parts"][number]);
}

export function appendWorkspacePromotedArtifactsPart(
  parts: UIMessage["parts"],
  artifacts: ToolArtifactDownloadRef[]
): void {
  const uniqueArtifacts = dedupeToolArtifactRefs(artifacts);
  if (uniqueArtifacts.length === 0) {
    return;
  }
  parts.push({
    type: WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE,
    data: createWorkspacePromotedArtifactsData(uniqueArtifacts)
  } as UIMessage["parts"][number]);
}

export function appendAssistantWebSourceParts(
  parts: UIMessage["parts"],
  message: Message,
  input: { includeSyntheticTool: boolean } = { includeSyntheticTool: true }
): void {
  const webMetadata = readCompatibleAssistantWebSourceMetadata(message);
  if (webMetadata.sources.length === 0) {
    return;
  }
  if (input.includeSyntheticTool) {
    appendSyntheticWebSearchToolPart(parts, message, webMetadata.sources);
  }
  const citationsBySourceId = new Map<string, typeof webMetadata.citations>();
  for (const citation of webMetadata.citations) {
    citationsBySourceId.set(citation.sourceId, [
      ...(citationsBySourceId.get(citation.sourceId) ?? []),
      citation
    ]);
  }

  for (const source of webMetadata.sources) {
    parts.push({
      type: "source-url",
      sourceId: source.id,
      url: source.url,
      ...(source.title ? { title: source.title } : {}),
      providerMetadata: {
        vivdCatalyst: createWebSourceProviderMetadata(
          source,
          citationsBySourceId.get(source.id) ?? []
        )
      }
    } as UIMessage["parts"][number]);
  }
}

/** A ref to a Knowledge Base passage as the agent cites it in its answer: `[K1]`. */
const KNOWLEDGE_CITATION = /\s?\[(K[1-9][0-9]*)\]/gu;

/**
 * The Knowledge Base passages an answer cites, as source chips beside its web sources: the
 * cited `[K1]` leaves the text, and each cited file and page is one chip. A ref the run did not
 * record stays as written, and a passage the answer does not cite is not shown.
 */
export function appendAssistantKnowledgeSourceParts(
  parts: UIMessage["parts"],
  message: Message
): void {
  const sources = readCompatibleAssistantKnowledgeSources(message);
  if (sources.length === 0) {
    return;
  }
  const byRef = new Map(sources.map((source) => [source.ref, source]));
  const cited = new Map<string, (typeof sources)[number]>();
  parts.forEach((part, index) => {
    if (part.type !== "text") return;
    parts[index] = {
      ...part,
      text: part.text.replace(KNOWLEDGE_CITATION, (marker, ref: string) => {
        const source = byRef.get(ref);
        if (!source) return marker;
        const key = `${source.knowledgeBase}/${source.documentId}/${source.page ?? ""}`;
        if (!cited.has(key)) cited.set(key, source);
        return "";
      })
    };
  });
  for (const source of cited.values()) {
    parts.push({
      type: "source-document",
      sourceId: `knowledge:${source.ref}`,
      mediaType: "application/octet-stream",
      title: source.fileName,
      filename: source.fileName,
      providerMetadata: {
        vivdCatalyst: {
          knowledge: { ...source }
        }
      }
    });
  }
}

function appendSyntheticWebSearchToolPart(
  parts: UIMessage["parts"],
  message: Message,
  sources: WebSource[]
): void {
  const queries = Array.from(
    new Set(
      sources
        .map((source) => source.query?.trim())
        .filter((query): query is string => Boolean(query))
    )
  );
  const output = unknownToJsonValue({
    sourceCount: sources.length,
    sources: sources.map((source) => ({
      url: source.url,
      ...(source.title ? { title: source.title } : {}),
      provider: source.provider,
      ...(source.query ? { query: source.query } : {}),
      ...(source.snippet ? { snippet: source.snippet } : {}),
      ...(source.resultPosition !== undefined ? { resultPosition: source.resultPosition } : {})
    }))
  });
  parts.push({
    type: "dynamic-tool",
    toolName: "web_search",
    toolCallId: `web_search:${message.id}`,
    title: "web_search",
    state: "output-available",
    input: queries.length === 0 ? {} : queries.length === 1 ? { query: queries[0] } : { queries },
    output
  } as UIMessage["parts"][number]);
}

function createWebSourceProviderMetadata(
  source: WebSource,
  citations: MessageCitation[]
): JsonObject {
  const metadata = unknownToJsonValue({
    provider: source.provider,
    ...(source.query ? { query: source.query } : {}),
    ...(source.snippet ? { snippet: source.snippet } : {}),
    ...(source.contentHash ? { contentHash: source.contentHash } : {}),
    ...(source.resultPosition !== undefined ? { resultPosition: source.resultPosition } : {}),
    citations
  });
  return isJsonObject(metadata) ? metadata : {};
}

function readUserAttachmentFileParts(message: Message): UIMessage["parts"] {
  return readCompatibleUserAttachmentRefs(message).map(toAttachmentFilePart);
}
