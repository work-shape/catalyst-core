import { groupPartByType, type GroupByContext, type PartState } from "@assistant-ui/react";
import { RUN_AGENT_TOOL_NAME } from "@work-shape/catalyst-core";
import { readApprovalRequestDisplay } from "../approvals/approval-request-model";
import {
  CONNECTION_DRAFT_TOOL_NAME,
  readConnectionDraft
} from "../../studio/build-area/connection-draft";
import { readToolDisplayPayloadFromToolResult } from "../../shared/domain-ui-widgets";
import { standingAssetOpen } from "../conversation/subject-run";
import { isOpenToolName, readPageSave } from "../../studio/pages/page-save";
import {
  isWorkspacePromotedArtifactsData,
  WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE
} from "../tools/tool-artifacts";
import {
  isWorkspacePromotedSurfacesData,
  WORKSPACE_PROMOTED_SURFACES_DATA_TYPE
} from "../tools/tool-surfaces";

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
  const byType = groupPartByType({
    "tool-call": [ASSISTANT_WORK_GROUP],
    "standalone-tool-call": []
  });
  // The card of a save says that a Page is being built, so it stands in the thread while the
  // run goes on and does not fold into the count of tool calls. An open of an asset stands
  // there too: a change of what the conversation is about is always seen. So does a subagent's
  // card, which is how the person follows and stops it.
  return (part, context) =>
    isPageSaveCall(part) || isStandingOpen(part) || isSubagentCall(part)
      ? []
      : byType(part, context);
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
  isError?: boolean;
  toolName?: string;
  args?: unknown;
}

export function createCompletedAssistantWorkIndices(
  parts: readonly AssistantPartOutline[],
  finalTextIndex: number
): number[] {
  if (finalTextIndex < 0) {
    return [];
  }
  return parts.flatMap((_part, index) =>
    staysVisibleAfterRun(parts, index, finalTextIndex) ? [] : [index]
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
    ...parts.flatMap((_part, index) =>
      index !== finalTextIndex && staysVisibleAfterRun(parts, index, finalTextIndex) ? [index] : []
    )
  ];
}

function staysVisibleAfterRun(
  parts: readonly AssistantPartOutline[],
  index: number,
  finalTextIndex: number
): boolean {
  const part = parts[index];
  if (!part) {
    return false;
  }
  return (
    index === finalTextIndex ||
    isApprovalRequestToolCall(part) ||
    isPageSaveOutcome(parts, index) ||
    isStandingOpen(part) ||
    isConnectionDraftCard(part) ||
    isSubagentCall(part) ||
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

/**
 * A revision an open built is a result of the run, not a step of it: its card is how the reader
 * opens the revision again, so it stays in the thread. An open the build refused folds away
 * with the other steps, unless it is the last open of the answer: then it is how the answer
 * ended, and the card says what the build found.
 */
function isPageSaveOutcome(parts: readonly AssistantPartOutline[], index: number): boolean {
  const part = parts[index];
  if (!part || !isPageSaveCall(part)) {
    return false;
  }
  return (
    readPageSave({ args: part.args, result: part.result }).state === "built" ||
    !parts.slice(index + 1).some(isPageSaveCall)
  );
}

/**
 * The agent's draft of REST API tools is a result of the run: its card is how the person opens
 * the approval list, so it stays in the thread. A refused draft folds away with the other steps.
 */
function isConnectionDraftCard(part: {
  type: string;
  toolName?: string;
  result?: unknown;
}): boolean {
  return (
    part.type === "tool-call" &&
    part.toolName === CONNECTION_DRAFT_TOOL_NAME &&
    readConnectionDraft(part.result) !== undefined
  );
}

/**
 * A subagent's card is how the person follows it and opens its thread, so it stands on its own
 * and stays. A call refused before it started a subagent folds away with the other steps.
 */
function isSubagentCall(part: { type: string; toolName?: string; isError?: boolean }): boolean {
  return (
    part.type === "tool-call" && part.toolName === RUN_AGENT_TOOL_NAME && part.isError !== true
  );
}

function isPageSaveCall(part: { type: string; toolName?: string } | undefined): boolean {
  return part?.type === "tool-call" && isOpenToolName(part.toolName);
}

/** A call that opened an asset and stood: its line leads to the asset's page. */
function isStandingOpen(
  part: { type: string; toolName?: string; result?: unknown; isError?: boolean } | undefined
): boolean {
  return (
    part?.type === "tool-call" &&
    part.toolName !== undefined &&
    standingAssetOpen({ toolName: part.toolName, result: part.result, isError: part.isError }) !==
      undefined
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

function isAssistantToolWorkPart(
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
  if (
    isPageSaveCall(part) ||
    isStandingOpen(part) ||
    isConnectionDraftCard(part) ||
    isSubagentCall(part)
  ) {
    return true;
  }
  return context.toolUIs?.[part.toolName]?.[0]?.standalone ?? false;
}
