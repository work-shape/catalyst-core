import { groupPartByType, type GroupByContext, type PartState } from "@assistant-ui/react";
import { readApprovalRequestDisplay } from "../approvals/approval-request-model";
import { readToolDisplayPayloadFromToolResult } from "../domain-ui-widgets";
import {
  isWorkspacePromotedArtifactsData,
  WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE
} from "../tool-artifacts";
import {
  isWorkspacePromotedSurfacesData,
  WORKSPACE_PROMOTED_SURFACES_DATA_TYPE
} from "../tool-surfaces";

export const ASSISTANT_WORK_GROUP = "group-work" as const;

export type AssistantWorkGroupKey = typeof ASSISTANT_WORK_GROUP;

export type AssistantWorkTimelineItem =
  | { type: "part"; index: number }
  | { type: "tool-group"; indices: number[] }
  | { type: "source-group"; indices: number[] };

export function createAssistantMessageGroupBy(): (
  part: PartState,
  context: GroupByContext
) => readonly AssistantWorkGroupKey[] {
  return groupPartByType({
    "tool-call": [ASSISTANT_WORK_GROUP],
    "standalone-tool-call": []
  });
}

export function createAssistantWorkTimelineItems(
  parts: readonly PartState[],
  indices: readonly number[],
  context: GroupByContext = {}
): AssistantWorkTimelineItem[] {
  const items: AssistantWorkTimelineItem[] = [];
  let currentToolGroup: number[] = [];
  let currentSourceGroup: number[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length === 0) {
      return;
    }
    items.push({ type: "tool-group", indices: currentToolGroup });
    currentToolGroup = [];
  };

  const flushSourceGroup = () => {
    if (currentSourceGroup.length === 0) {
      return;
    }
    items.push({ type: "source-group", indices: currentSourceGroup });
    currentSourceGroup = [];
  };

  for (const index of indices) {
    const part = parts[index];
    if (!part) {
      continue;
    }
    if (part.type === "reasoning") {
      continue;
    }
    if (isAssistantToolWorkPart(part, context)) {
      flushSourceGroup();
      currentToolGroup.push(index);
      continue;
    }
    if (isSourcePart(part)) {
      flushToolGroup();
      currentSourceGroup.push(index);
      continue;
    }
    flushToolGroup();
    flushSourceGroup();
    items.push({ type: "part", index });
  }
  flushToolGroup();
  flushSourceGroup();
  return items;
}

export function countAssistantWorkTimelineSteps(
  items: readonly AssistantWorkTimelineItem[]
): number {
  return items.filter((item) => item.type !== "source-group").length;
}

export function createRenderableAssistantToolGroupIndices(
  parts: readonly PartState[],
  indices: readonly number[]
): number[] {
  const entries: Array<{ key: string; index: number }> = [];
  for (const index of indices) {
    const part = parts[index];
    if (!part) {
      continue;
    }
    if (part.type !== "tool-call") {
      continue;
    }
    const key = `tool:${part.toolCallId}`;
    const existing = entries.find((entry) => entry.key === key);
    if (existing) {
      existing.index = index;
      continue;
    }
    entries.push({ key, index });
  }
  return entries.map((entry) => entry.index);
}

interface AssistantPartOutline {
  type: string;
  data?: unknown;
  name?: string;
  result?: unknown;
}

export function createCompletedAssistantWorkIndices(
  parts: readonly AssistantPartOutline[],
  finalTextIndex: number
): number[] {
  if (finalTextIndex < 0) {
    return [];
  }
  return parts.flatMap((part, index) =>
    staysVisibleAfterRun(part, index, finalTextIndex) ? [] : [index]
  );
}

/**
 * The final text comes first, then everything that stays visible in message
 * order. An Approval Request card is usually produced before the final text,
 * so it lands below the sentence that announces it.
 */
export function createVisibleFinalAssistantPartIndices(
  parts: readonly AssistantPartOutline[],
  finalTextIndex: number
): number[] {
  if (finalTextIndex < 0) {
    return [];
  }
  return [
    finalTextIndex,
    ...parts.flatMap((part, index) =>
      index !== finalTextIndex && staysVisibleAfterRun(part, index, finalTextIndex) ? [index] : []
    )
  ];
}

function staysVisibleAfterRun(
  part: AssistantPartOutline,
  index: number,
  finalTextIndex: number
): boolean {
  return (
    index === finalTextIndex ||
    isApprovalRequestToolCall(part) ||
    (index > finalTextIndex && isVisibleFinalAssistantPart(part))
  );
}

/**
 * An Approval Request card carries a pending decision, so it must not fold
 * into the collapsed work summary with the other tool calls of the run.
 */
function isApprovalRequestToolCall(part: AssistantPartOutline): boolean {
  return (
    part.type === "tool-call" &&
    readApprovalRequestDisplay(readToolDisplayPayloadFromToolResult(part.result)) !== undefined
  );
}

export function findFinalAssistantTextPartIndex(
  parts: readonly { type: string; text?: string }[]
): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
      return index;
    }
  }
  return -1;
}

export function isAssistantToolWorkPart(
  part: PartState | undefined,
  context: GroupByContext = {}
): boolean {
  if (!part) {
    return false;
  }
  if (part.type === "tool-call") {
    return !isStandaloneToolCall(part, context);
  }
  return false;
}

function isSourcePart(part: PartState): boolean {
  return part.type === "source";
}

function isVisibleFinalAssistantPart(part: {
  type: string;
  data?: unknown;
  name?: string;
}): boolean {
  if (part.type === "file" || part.type === "image") {
    return true;
  }
  if (part.type === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE) {
    return true;
  }
  if (part.type === WORKSPACE_PROMOTED_SURFACES_DATA_TYPE) {
    return true;
  }
  if (part.type === "data") {
    return (
      part.name === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE ||
      part.name === WORKSPACE_PROMOTED_SURFACES_DATA_TYPE ||
      isWorkspacePromotedArtifactsData(part.data) ||
      isWorkspacePromotedSurfacesData(part.data)
    );
  }
  return false;
}

function isStandaloneToolCall(
  part: Extract<PartState, { type: "tool-call" }>,
  context: GroupByContext
): boolean {
  if (part.mcp?.app?.resourceUri?.startsWith("ui://")) {
    return true;
  }
  return context.toolUIs?.[part.toolName]?.[0]?.standalone ?? false;
}
