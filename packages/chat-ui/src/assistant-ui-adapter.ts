import type { UIMessage } from "ai";
import {
  isJsonObject,
  unknownToJsonValue,
  type JsonObject,
  type MessageCitation,
  type WebSource
} from "@vivd-catalyst/core";
import type {
  AgentRunProjection,
  DraftAttachment,
  Message
} from "@vivd-catalyst/api-client";
import {
  readCompatibleAssistantFinalRunId,
  readCompatibleAssistantToolCalls,
  readCompatibleAssistantWebSourceMetadata,
  readCompatibleMessageRunId,
  readCompatiblePersistedToolResult,
  readCompatibleUserAttachmentRefs,
  type PersistedToolResult
} from "./assistant/assistant-message-compat";
import {
  WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE,
  createWorkspacePromotedArtifactsData,
  dedupeToolArtifactRefs,
  readSurfacedToolArtifactRefs,
  type ToolArtifactDownloadRef
} from "./tool-artifacts";
import {
  WORKSPACE_PROMOTED_SURFACES_DATA_TYPE,
  createWorkspacePromotedSurfacesData,
  dedupeToolSurfaceRefs,
  readToolSurfaceRefs,
  type ToolSurfaceRef
} from "./tool-surfaces";
import { readWorkspaceToolErrorText } from "./workspace-tool-display";

export interface AssistantUiActiveRun {
  run: {
    id: string;
    status: string;
  };
  projection: AgentRunProjection;
}

export interface AssistantUiMessageMetadata {
  source?: "active-run";
  completedRunId?: string;
}

interface AiSdkMessageFormatRepository {
  headId: string | null;
  messages: Array<{
    parentId: string | null;
    message: UIMessage;
  }>;
}

interface AssistantRunMessageGroup {
  finalMessage: Message;
  messageIds: Set<string>;
  messages: Message[];
}

interface UiMessagePartProjectionOptions {
  includeSyntheticWebSearchTool?: boolean;
}

export function toAiSdkMessageRepository(messages: UIMessage[]): AiSdkMessageFormatRepository {
  let parentId: string | null = null;
  return {
    headId: messages.at(-1)?.id ?? null,
    messages: messages.map((message) => {
      const item = {
        parentId,
        message
      };
      parentId = message.id;
      return item;
    })
  };
}

export function toUiMessages(
  messages: Message[],
  activeRun?: AssistantUiActiveRun,
  completedRunProjections: Record<string, AgentRunProjection> = {}
): UIMessage[] {
  const visibleMessages = activeRun
    ? withoutRunResponseMessages(messages, activeRun.run.id)
    : messages;
  const projectedMessages = toPersistedUiMessages(visibleMessages, completedRunProjections);
  const activeRunMessage = activeRun ? toActiveRunUiMessage(activeRun) : undefined;
  return activeRunMessage ? [...projectedMessages, activeRunMessage] : projectedMessages;
}

export function createMessageSnapshotKey(
  messages: Message[],
  activeRun?: AssistantUiActiveRun,
  completedRunProjections: Record<string, AgentRunProjection> = {}
): string {
  return JSON.stringify({
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      metadata: message.metadata
    })),
    activeRun: activeRun
      ? {
          run: activeRun.run,
          projection: activeRun.projection
        }
      : undefined,
    completedRunProjections
  });
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

function toPersistedUiMessages(
  messages: Message[],
  completedRunProjections: Record<string, AgentRunProjection>
): UIMessage[] {
  const toolResultsByToolCallId = new Map<string, PersistedToolResult>();
  const surfacedArtifactsByRunId = new Map<string, ToolArtifactDownloadRef[]>();
  const surfacedSurfacesByRunId = new Map<string, ToolSurfaceRef[]>();
  for (const message of messages) {
    const toolResult = readCompatiblePersistedToolResult(message);
    if (toolResult) {
      toolResultsByToolCallId.set(toolResult.toolCallId, toolResult);
      const runId = readCompatibleMessageRunId(message);
      const artifacts = readSurfacedToolArtifactRefs(toolResult.output, toolResult.toolName);
      if (runId && artifacts.length > 0) {
        surfacedArtifactsByRunId.set(
          runId,
          dedupeToolArtifactRefs([...(surfacedArtifactsByRunId.get(runId) ?? []), ...artifacts])
        );
      }
      const surfaces = readToolSurfaceRefs(toolResult.output, {
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName
      });
      if (runId && surfaces.length > 0) {
        surfacedSurfacesByRunId.set(
          runId,
          dedupeToolSurfaceRefs([...(surfacedSurfacesByRunId.get(runId) ?? []), ...surfaces])
        );
      }
    }
  }

  const assistantRunMessageGroups = createAssistantRunMessageGroups(messages);
  return messages.flatMap((message): UIMessage[] => {
    if (!isRenderableMessage(message)) {
      return [];
    }

    const runId = readCompatibleMessageRunId(message);
    const completedRunProjection = runId ? completedRunProjections[runId] : undefined;
    if (completedRunProjection) {
      if (readCompatibleAssistantFinalRunId(message) !== runId) {
        return [];
      }
      return [
        toCompletedRunProjectionUiMessage(
          message,
          completedRunProjection,
          surfacedArtifactsByRunId,
          surfacedSurfacesByRunId
        )
      ];
    }

    const runGroup = runId ? assistantRunMessageGroups.get(runId) : undefined;
    if (runGroup?.messageIds.has(message.id)) {
      if (message.id !== runGroup.finalMessage.id) {
        return [];
      }
      return [
        toCombinedAssistantRunUiMessage(
          runGroup,
          toolResultsByToolCallId,
          surfacedArtifactsByRunId,
          surfacedSurfacesByRunId
        )
      ];
    }

    return [
      toPersistedUiMessage(
        message,
        toolResultsByToolCallId,
        surfacedArtifactsByRunId,
        surfacedSurfacesByRunId
      )
    ];
  });
}

function toPersistedUiMessage(
  message: Message,
  toolResultsByToolCallId: Map<string, PersistedToolResult>,
  surfacedArtifactsByRunId: Map<string, ToolArtifactDownloadRef[]>,
  surfacedSurfacesByRunId: Map<string, ToolSurfaceRef[]>
): UIMessage {
  const metadata = createPersistedUiMessageMetadata(message);
  return {
    id: message.id,
    role: message.role as UIMessage["role"],
    ...(metadata ? { metadata } : {}),
    parts: toUiMessageParts(message, toolResultsByToolCallId, surfacedArtifactsByRunId, surfacedSurfacesByRunId)
  };
}

function toCombinedAssistantRunUiMessage(
  group: AssistantRunMessageGroup,
  toolResultsByToolCallId: Map<string, PersistedToolResult>,
  surfacedArtifactsByRunId: Map<string, ToolArtifactDownloadRef[]>,
  surfacedSurfacesByRunId: Map<string, ToolSurfaceRef[]>
): UIMessage {
  const messages = stripRepeatedFinalRunPrefix(group.messages, group.finalMessage);
  const runHasExplicitWebSearchTool = group.messages.some((message) =>
    readCompatibleAssistantToolCalls(message).some((toolCall) => toolCall.toolName === "web_search")
  );
  const parts = messages.flatMap((message) =>
    toUiMessageParts(message, toolResultsByToolCallId, surfacedArtifactsByRunId, surfacedSurfacesByRunId, {
      includeSyntheticWebSearchTool: !runHasExplicitWebSearchTool
    })
  );
  const metadata = createPersistedUiMessageMetadata(group.finalMessage);
  return {
    id: group.finalMessage.id,
    role: "assistant",
    ...(metadata ? { metadata } : {}),
    parts: parts.length > 0
      ? parts
      : [
          {
            type: "text",
            text: "",
            state: "done"
          } as UIMessage["parts"][number]
        ]
  };
}

function stripRepeatedFinalRunPrefix(messages: Message[], finalMessage: Message): Message[] {
  const previousAssistantText = messages
    .filter((message) => message.id !== finalMessage.id && message.role === "assistant")
    .map((message) => message.text)
    .join("");
  if (!previousAssistantText || !finalMessage.text.startsWith(previousAssistantText)) {
    return messages;
  }
  const finalAnswerText = finalMessage.text.slice(previousAssistantText.length);
  if (finalAnswerText.trim().length === 0) {
    return messages;
  }
  return messages.map((message) =>
    message.id === finalMessage.id
      ? {
          ...message,
          text: finalAnswerText
        }
      : message
  );
}

function toCompletedRunProjectionUiMessage(
  finalMessage: Message,
  projection: AgentRunProjection,
  surfacedArtifactsByRunId: Map<string, ToolArtifactDownloadRef[]>,
  surfacedSurfacesByRunId: Map<string, ToolSurfaceRef[]>
): UIMessage {
  const completedProjection = projectionWithPersistedFinalTextFallback(projection, finalMessage.text);
  const parts = toProjectionUiMessageParts(completedProjection, {
    run: {
      id: completedProjection.runId,
      status: completedProjection.status
    },
    projection: completedProjection
  });
  appendAssistantWebSourceParts(parts, finalMessage, {
    includeSyntheticTool: false
  });
  appendWorkspacePromotedSurfacesPart(
    parts,
    dedupeToolSurfaceRefs([
      ...projection.parts.flatMap((part): ToolSurfaceRef[] =>
        part.type === "tool_call"
          ? readToolSurfaceRefs(part.output, {
              toolCallId: part.toolCallId,
              toolName: part.toolName
            })
          : []
      ),
      ...(surfacedSurfacesByRunId.get(projection.runId) ?? [])
    ])
  );
  appendWorkspacePromotedArtifactsPart(
    parts,
    dedupeToolArtifactRefs([
      ...projection.parts.flatMap((part): ToolArtifactDownloadRef[] =>
        part.type === "tool_call" ? readSurfacedToolArtifactRefs(part.output, part.toolName) : []
      ),
      ...(surfacedArtifactsByRunId.get(projection.runId) ?? [])
    ])
  );
  const metadata = createPersistedUiMessageMetadata(finalMessage);
  return {
    id: finalMessage.id,
    role: "assistant",
    ...(metadata ? { metadata } : {}),
    parts: parts.length > 0
      ? parts
      : [
          {
            type: "text",
            text: "",
            state: "done"
          } as UIMessage["parts"][number]
        ]
  };
}

function projectionWithPersistedFinalTextFallback(
  projection: AgentRunProjection,
  finalText: string
): AgentRunProjection {
  if (finalText.trim().length === 0) {
    return projection;
  }
  const observedText = projection.parts
    .filter((part): part is Extract<AgentRunProjection["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (
    observedText.length > 0 &&
    (observedText === finalText ||
      observedText.endsWith(finalText) ||
      finalText.endsWith(observedText))
  ) {
    return projection;
  }
  const missingText = observedText.length > 0 && finalText.startsWith(observedText)
    ? finalText.slice(observedText.length)
    : finalText;
  if (missingText.trim().length === 0) {
    return projection;
  }
  return {
    ...projection,
    text: projection.text || finalText,
    parts: [
      ...projection.parts,
      {
        type: "text",
        text: missingText
      }
    ]
  };
}

function createAssistantRunMessageGroups(messages: Message[]): Map<string, AssistantRunMessageGroup> {
  const messagesByRunId = new Map<string, Message[]>();
  const finalMessageByRunId = new Map<string, Message>();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const runId = readCompatibleMessageRunId(message);
    if (!runId) {
      continue;
    }
    messagesByRunId.set(runId, [...(messagesByRunId.get(runId) ?? []), message]);
    if (readCompatibleAssistantFinalRunId(message) === runId) {
      finalMessageByRunId.set(runId, message);
    }
  }

  const groups = new Map<string, AssistantRunMessageGroup>();
  for (const [runId, runMessages] of messagesByRunId.entries()) {
    const finalMessage = finalMessageByRunId.get(runId);
    if (!finalMessage) {
      continue;
    }
    const finalIndex = runMessages.findIndex((message) => message.id === finalMessage.id);
    if (finalIndex <= 0) {
      continue;
    }
    const groupedMessages = runMessages.slice(0, finalIndex + 1);
    groups.set(runId, {
      finalMessage,
      messageIds: new Set(groupedMessages.map((message) => message.id)),
      messages: groupedMessages
    });
  }
  return groups;
}

function isRenderableMessage(message: Message): boolean {
  return message.role === "user" || message.role === "assistant" || message.role === "system";
}

function createPersistedUiMessageMetadata(message: Message): AssistantUiMessageMetadata | undefined {
  const completedRunId = readCompatibleAssistantFinalRunId(message);
  return completedRunId ? { completedRunId } : undefined;
}

function toActiveRunUiMessage(activeRun: AssistantUiActiveRun): UIMessage {
  const parts = toProjectionUiMessageParts(activeRun.projection, activeRun);
  appendWorkspacePromotedArtifactsPart(
    parts,
    activeRun.projection.parts.flatMap((part): ToolArtifactDownloadRef[] =>
      part.type === "tool_call" ? readSurfacedToolArtifactRefs(part.output, part.toolName) : []
    )
  );

  return {
    id: activeRun.run.id,
    role: "assistant",
    metadata: {
      source: "active-run"
    } satisfies AssistantUiMessageMetadata,
    parts
  };
}

function toProjectionUiMessageParts(
  projection: AgentRunProjection,
  activeRun?: AssistantUiActiveRun
): UIMessage["parts"] {
  const terminal =
    projection.status === "completed" ||
    projection.status === "cancelled" ||
    projection.status === "failed";
  const projectionParts = projection.parts ?? [];
  const orderedParts = projectionParts.length > 0
    ? projectionParts
    : legacyActiveRunParts(projection);
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

function legacyActiveRunParts(
  projection: AgentRunProjection
): AgentRunProjection["parts"] {
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
    state: projectedErrorText ? "output-error" : toAssistantToolState(toolCall.state),
    input: toolCall.input,
    ...(projectedErrorText
      ? {
          errorText: projectedErrorText,
          ...(toolCall.output !== undefined ? { output: toolCall.output } : {})
        }
      : toolCall.state === "output_error"
      ? {
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

function toUiMessageParts(
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
    const projectedErrorText = toolResult?.status === "failed" ? toolResult.errorText : workspaceToolError;
    parts.push({
      type: "dynamic-tool",
      toolName: toolCall.toolName,
      toolCallId: toolCall.toolCallId,
      title: toolCall.toolName,
      state: projectedErrorText ? "output-error" : toolResult ? "output-available" : "input-available",
      input: toolCall.input,
      ...(projectedErrorText
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
  const finalRunId = readCompatibleAssistantFinalRunId(message);
  appendWorkspacePromotedSurfacesPart(
    parts,
    finalRunId ? surfacedSurfacesByRunId.get(finalRunId) ?? [] : []
  );
  appendWorkspacePromotedArtifactsPart(
    parts,
    finalRunId ? surfacedArtifactsByRunId.get(finalRunId) ?? [] : []
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

function appendWorkspacePromotedSurfacesPart(
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

function appendWorkspacePromotedArtifactsPart(
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

function appendAssistantWebSourceParts(
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
        vivdCatalyst: createWebSourceProviderMetadata(source, citationsBySourceId.get(source.id) ?? [])
      }
    } as UIMessage["parts"][number]);
  }
}

function appendSyntheticWebSearchToolPart(
  parts: UIMessage["parts"],
  message: Message,
  sources: WebSource[]
): void {
  const queries = Array.from(new Set(
    sources.map((source) => source.query?.trim()).filter((query): query is string => Boolean(query))
  ));
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

function createWebSourceProviderMetadata(source: WebSource, citations: MessageCitation[]): JsonObject {
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

function withoutRunResponseMessages(messages: Message[], runId: string): Message[] {
  return messages.filter((message) => {
    const messageRunId = readCompatibleMessageRunId(message);
    if (messageRunId !== runId) {
      return true;
    }
    return message.role === "user";
  });
}

function readUserAttachmentFileParts(message: Message): UIMessage["parts"] {
  return readCompatibleUserAttachmentRefs(message).map(toAttachmentFilePart);
}
