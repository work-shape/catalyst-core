import type { AgentRun, LocaleCode, SubagentSummary } from "@work-shape/catalyst-api-client";
import type { BadgeTone } from "@work-shape/catalyst-ui";
import { formatElapsed } from "../../shared/locale-format";
import type { TranslationKey } from "../../shared/i18n";
import { isLiveRunStatus } from "../conversation/conversation-controller-state";

// What a person reads of a subagent (CR-1): on its card in the parent's thread, in its row of
// the Resources panel and in the head of its own thread.

/** The state of a subagent as the interface names it. `starting` is a call without its child yet. */
export type SubagentState =
  "starting" | "running" | "stopping" | "completed" | "failed" | "cancelled";

export function subagentState(status: AgentRun["status"] | undefined): SubagentState {
  if (status === undefined) return "starting";
  if (status === "cancelling") return "stopping";
  if (isLiveRunStatus(status)) return "running";
  return status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled";
}

/** How the subagent of an answered `run_agent` call ended, as its result says. */
export function answeredSubagentState(result: unknown): SubagentState | undefined {
  if (typeof result !== "object" || result === null || !("status" in result)) return undefined;
  const { status } = result;
  return status === "completed" || status === "failed" || status === "cancelled"
    ? status
    : undefined;
}

/** Whether the subagent has not ended, so its card offers Stop and its row stands under Active. */
export function isSubagentActive(state: SubagentState): boolean {
  return state === "starting" || state === "running" || state === "stopping";
}

const STATE_LABELS: Record<SubagentState, TranslationKey> = {
  starting: "subagents.statusStarting",
  running: "subagents.statusRunning",
  stopping: "subagents.statusStopping",
  completed: "subagents.statusCompleted",
  failed: "subagents.statusFailed",
  cancelled: "subagents.statusCancelled"
};

const STATE_TONES: Record<SubagentState, BadgeTone> = {
  starting: "info",
  running: "info",
  stopping: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "neutral"
};

export function subagentStateLabel(state: SubagentState): TranslationKey {
  return STATE_LABELS[state];
}

export function subagentStateTone(state: SubagentState): BadgeTone {
  return STATE_TONES[state];
}

/** How long the subagent ran, or has run so far while it runs. */
export function subagentDuration(
  subagent: Pick<SubagentSummary, "startedAt" | "endedAt">,
  now: Date,
  locale: LocaleCode,
  soFar: (duration: string) => string
): string {
  return subagent.endedAt === undefined
    ? soFar(formatElapsed(subagent.startedAt, now, locale))
    : formatElapsed(subagent.startedAt, new Date(subagent.endedAt), locale);
}

/** The subagents of a conversation as the Resources panel lists them: Active, then Done, newest first. */
export function groupSubagents(subagents: readonly SubagentSummary[]): {
  active: SubagentSummary[];
  done: SubagentSummary[];
} {
  const newestFirst = [...subagents].sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId)
  );
  return {
    active: newestFirst.filter((subagent) => isSubagentActive(subagentState(subagent.status))),
    done: newestFirst.filter((subagent) => !isSubagentActive(subagentState(subagent.status)))
  };
}

// The way back from a subagent's thread leads to its card in the parent's thread: the thread
// view names the call, and the card of that call brings itself into view once it is drawn.
let revealToolCallId: string | undefined;

export function requestToolCallReveal(toolCallId: string): void {
  revealToolCallId = toolCallId;
}

/** Whether the card of this call was asked to come into view; the request is taken once. */
export function takeToolCallReveal(toolCallId: string): boolean {
  if (revealToolCallId !== toolCallId) return false;
  revealToolCallId = undefined;
  return true;
}
