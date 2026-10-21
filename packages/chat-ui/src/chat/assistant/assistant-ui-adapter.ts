import type { AgentRunProjection, Message } from "@work-shape/catalyst-api-client";
import type { UIMessage } from "ai";
import { readToolDisplayPayloadFromToolResult } from "../../shared/domain-ui-widgets";
import {
  readApprovalDecisionEvent,
  readApprovalRequestDisplay
} from "../approvals/approval-request-model";
import {
  dedupeToolArtifactRefs,
  readSurfacedToolArtifactRefs,
  type ToolArtifactDownloadRef
} from "../tools/tool-artifacts";
import {
  dedupeToolSurfaceRefs,
  readToolSurfaceRefs,
  type ToolSurfaceRef
} from "../tools/tool-surfaces";
import {
  readCompatibleAssistantContextCompacted,
  readCompatibleAssistantFinalRunId,
  readCompatibleAssistantToolCalls,
  readCompatibleMessageRunId,
  readCompatiblePersistedToolResult,
  readSteeredRunId,
  type PersistedToolResult
} from "./assistant-message-compat";
import {
  appendAssistantKnowledgeSourceParts,
  appendAssistantWebSourceParts,
  appendWorkspacePromotedArtifactsPart,
  appendWorkspacePromotedSurfacesPart,
  splitProjectionAtSteers,
  toActiveRunUiMessages,
  toProjectionUiMessageParts,
  toSteeredUiMessage,
  toUiMessageParts
} from "./assistant-ui-parts";
import type {
  AssistantUiActiveRun,
  AssistantUiApprovalDecision,
  AssistantUiMessageMetadata
} from "./assistant-ui-types";
export { toAttachmentFilePart } from "./assistant-ui-parts";
export type {
  AssistantUiActiveRun,
  AssistantUiApprovalDecision,
  AssistantUiMessageCustomMetadata,
  AssistantUiMessageMetadata
} from "./assistant-ui-types";

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
  /**
   * The run's messages cut where its person steered it (FU-2), keyed by each piece's last
   * message: the steered messages stand between the pieces in the transcript.
   */
  segmentsByLastId: Map<string, Message[]>;
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
  const activeRunMessages = activeRun ? toActiveRunUiMessages(activeRun) : [];
  const activeRunMessage = activeRunMessages.at(-1);
  if (!activeRunMessage || leftNothingToShow(activeRun, activeRunMessage)) {
    return [...projectedMessages, ...activeRunMessages.slice(0, -1)];
  }
  return [...projectedMessages, ...activeRunMessages];
}

/**
 * A run that failed or was stopped before anything of its answer arrived, such as one that was
 * refused. It gets no row: an empty one would show only the copy and retry buttons, and the
 * notice above the composer says what happened.
 */
function leftNothingToShow(
  activeRun: AssistantUiActiveRun | undefined,
  message: UIMessage
): boolean {
  const status = activeRun?.projection.status;
  return (
    (status === "failed" || status === "cancelled") &&
    message.parts.every((part) => part.type === "text" && part.text.trim().length === 0)
  );
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

function toPersistedUiMessages(
  messages: Message[],
  completedRunProjections: Record<string, AgentRunProjection>
): UIMessage[] {
  const toolResultsByToolCallId = new Map<string, PersistedToolResult>();
  const surfacedArtifactsByRunId = new Map<string, ToolArtifactDownloadRef[]>();
  const surfacedSurfacesByRunId = new Map<string, ToolSurfaceRef[]>();
  const approvalRequestIds = new Set<string>();
  for (const message of messages) {
    const approvalDecision = readApprovalDecisionEvent(message);
    if (approvalDecision) {
      approvalRequestIds.add(approvalDecision.requestId);
    }
    const toolResult = readCompatiblePersistedToolResult(message);
    if (toolResult) {
      toolResultsByToolCallId.set(toolResult.toolCallId, toolResult);
      const approvalRequest = readApprovalRequestDisplay(
        readToolDisplayPayloadFromToolResult(toolResult.output)
      );
      if (approvalRequest) {
        approvalRequestIds.add(approvalRequest.requestId);
      }
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
    if (message.role === "system") {
      // The stored text is a note for the model. Only a decision has a place
      // in the thread, and it is rendered from its metadata.
      const approvalDecision = readApprovalDecisionEvent(message);
      return approvalDecision
        ? [
            toApprovalDecisionUiMessage(message, {
              ...approvalDecision,
              ambiguous: approvalRequestIds.size > 1
            })
          ]
        : [];
    }
    if (!isRenderableMessage(message)) {
      return [];
    }
    // A run shown from its projection shows the messages steered into it in place.
    const steeredInto = readSteeredRunId(message);
    if (steeredInto && completedRunProjections[steeredInto]) {
      return [];
    }

    const runId = readCompatibleMessageRunId(message);
    const completedRunProjection = runId ? completedRunProjections[runId] : undefined;
    if (completedRunProjection) {
      if (readCompatibleAssistantFinalRunId(message) !== runId) {
        return [];
      }
      return toCompletedRunProjectionUiMessages(
        message,
        completedRunProjection,
        surfacedArtifactsByRunId,
        surfacedSurfacesByRunId
      );
    }

    const runGroup = runId ? assistantRunMessageGroups.get(runId) : undefined;
    if (runGroup?.messageIds.has(message.id)) {
      const segment = runGroup.segmentsByLastId.get(message.id);
      if (!segment) {
        return [];
      }
      return [
        toCombinedAssistantRunUiMessage(
          runGroup,
          segment,
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

function toApprovalDecisionUiMessage(
  message: Message,
  approvalDecision: AssistantUiApprovalDecision
): UIMessage {
  return {
    id: message.id,
    role: "system",
    metadata: { custom: { approvalDecision } } satisfies AssistantUiMessageMetadata,
    // assistant-ui accepts a system message only with exactly one text part.
    parts: [{ type: "text", text: "", state: "done" }]
  };
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
    parts: toUiMessageParts(
      message,
      toolResultsByToolCallId,
      surfacedArtifactsByRunId,
      surfacedSurfacesByRunId
    )
  };
}

function toCombinedAssistantRunUiMessage(
  group: AssistantRunMessageGroup,
  segment: Message[],
  toolResultsByToolCallId: Map<string, PersistedToolResult>,
  surfacedArtifactsByRunId: Map<string, ToolArtifactDownloadRef[]>,
  surfacedSurfacesByRunId: Map<string, ToolSurfaceRef[]>
): UIMessage {
  // The final answer's repeated prefix is read against the whole run, then cut to the piece.
  const inSegment = new Set(segment.map((message) => message.id));
  const messages = stripRepeatedFinalRunPrefix(group.messages, group.finalMessage).filter(
    (message) => inSegment.has(message.id)
  );
  const last = segment.at(-1) ?? group.finalMessage;
  const isFinal = last.id === group.finalMessage.id;
  const runHasExplicitWebSearchTool = group.messages.some((message) =>
    readCompatibleAssistantToolCalls(message).some((toolCall) => toolCall.toolName === "web_search")
  );
  const parts = messages.flatMap((message) =>
    toUiMessageParts(
      message,
      toolResultsByToolCallId,
      surfacedArtifactsByRunId,
      surfacedSurfacesByRunId,
      {
        includeSyntheticWebSearchTool: !runHasExplicitWebSearchTool
      }
    )
  );
  const metadata = isFinal
    ? createPersistedUiMessageMetadata(group.finalMessage, group.messages)
    : undefined;
  return {
    id: last.id,
    role: "assistant",
    ...(metadata ? { metadata } : {}),
    parts:
      parts.length > 0
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

/**
 * A completed run shown from its projection, at its final message: one assistant message, or,
 * where its person steered it, its answers with the steered messages between them.
 */
function toCompletedRunProjectionUiMessages(
  finalMessage: Message,
  projection: AgentRunProjection,
  surfacedArtifactsByRunId: Map<string, ToolArtifactDownloadRef[]>,
  surfacedSurfacesByRunId: Map<string, ToolSurfaceRef[]>
): UIMessage[] {
  const segments = splitProjectionAtSteers(projection);
  return segments.map((segment, index): UIMessage => {
    if (segment.kind === "steer") return toSteeredUiMessage(segment);
    if (index === segments.length - 1) {
      return toCompletedRunProjectionUiMessage(
        finalMessage,
        projection,
        segment.projection,
        surfacedArtifactsByRunId,
        surfacedSurfacesByRunId
      );
    }
    return {
      id: `${finalMessage.id}:${index}`,
      role: "assistant",
      parts: toProjectionUiMessageParts(segment.projection)
    };
  });
}

function toCompletedRunProjectionUiMessage(
  finalMessage: Message,
  projection: AgentRunProjection,
  shown: AgentRunProjection,
  surfacedArtifactsByRunId: Map<string, ToolArtifactDownloadRef[]>,
  surfacedSurfacesByRunId: Map<string, ToolSurfaceRef[]>
): UIMessage {
  const completedProjection = projectionWithPersistedFinalTextFallback(shown, finalMessage.text);
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
  appendAssistantKnowledgeSourceParts(parts, finalMessage);
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
  const persistedMetadata = createPersistedUiMessageMetadata(finalMessage);
  const metadata = {
    custom: {
      ...persistedMetadata?.custom,
      ...(projection.durationMs !== undefined ? { runDurationMs: projection.durationMs } : {})
    }
  } satisfies AssistantUiMessageMetadata;
  return {
    id: finalMessage.id,
    role: "assistant",
    metadata,
    parts:
      parts.length > 0
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
    .filter(
      (part): part is Extract<AgentRunProjection["parts"][number], { type: "text" }> =>
        part.type === "text"
    )
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
  const missingText =
    observedText.length > 0 && finalText.startsWith(observedText)
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

function createAssistantRunMessageGroups(
  messages: Message[]
): Map<string, AssistantRunMessageGroup> {
  const messagesByRunId = new Map<string, Message[]>();
  const finalMessageByRunId = new Map<string, Message>();
  // Where a run's person steered it: the run's piece before stops at its last message so far.
  const steeredAfterIds = new Map<string, Set<string>>();

  for (const message of messages) {
    const steeredInto = readSteeredRunId(message);
    if (steeredInto) {
      const before = messagesByRunId.get(steeredInto)?.at(-1);
      if (before) {
        steeredAfterIds.set(
          steeredInto,
          (steeredAfterIds.get(steeredInto) ?? new Set()).add(before.id)
        );
      }
      continue;
    }
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
    const cuts = steeredAfterIds.get(runId) ?? new Set<string>();
    const segmentsByLastId = new Map<string, Message[]>();
    let segment: Message[] = [];
    for (const message of groupedMessages) {
      segment.push(message);
      if (cuts.has(message.id) || message.id === finalMessage.id) {
        segmentsByLastId.set(message.id, segment);
        segment = [];
      }
    }
    groups.set(runId, {
      finalMessage,
      messageIds: new Set(groupedMessages.map((message) => message.id)),
      messages: groupedMessages,
      segmentsByLastId
    });
  }
  return groups;
}

function isRenderableMessage(message: Message): boolean {
  return message.role === "user" || message.role === "assistant";
}

function createPersistedUiMessageMetadata(
  message: Message,
  runMessages: Message[] = [message]
): AssistantUiMessageMetadata | undefined {
  const completedRunId = readCompatibleAssistantFinalRunId(message);
  const contextCompacted = runMessages.some(readCompatibleAssistantContextCompacted);
  return completedRunId || contextCompacted
    ? {
        custom: {
          ...(completedRunId ? { completedRunId } : {}),
          ...(contextCompacted ? { contextCompacted: true } : {})
        }
      }
    : undefined;
}

function withoutRunResponseMessages(messages: Message[], runId: string): Message[] {
  return messages.filter((message) => {
    // The active run shows the messages steered into it in place.
    if (readSteeredRunId(message) === runId) {
      return false;
    }
    const messageRunId = readCompatibleMessageRunId(message);
    if (messageRunId !== runId) {
      return true;
    }
    return message.role === "user";
  });
}
