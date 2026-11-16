import { RUN_AGENT_TOOL_NAME } from "@work-shape/catalyst-core";

export interface ThreadActivityPart {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  // Thread-level parts (ThreadAssistantMessagePart) carry `result`/`isError`
  // but no `status`; only message-level PartState has `status`.
  result?: unknown;
  isError?: boolean;
  status?: {
    type?: string;
  };
}

export interface ThreadActivityMessage {
  id?: string;
  role?: string;
  status?: {
    type?: string;
  };
  parts?: readonly ThreadActivityPart[];
}

export interface ThreadActivityInput {
  conversationRunning?: boolean;
  optimisticPending?: boolean;
  threadRunning?: boolean;
}

/**
 * What the run is doing right now, derived from the assistant parts.
 *
 * This only picks the wording of the single activity row. It never decides
 * whether the row exists — that is `shouldShowRunActivity` alone — so a
 * changing part tree can no longer move the indicator around the page.
 */
export type RunActivity = { kind: "tool"; toolName: string } | { kind: "reasoning" };

export function isThreadBusy({
  conversationRunning,
  optimisticPending,
  threadRunning
}: ThreadActivityInput): boolean {
  return Boolean(conversationRunning || optimisticPending || threadRunning);
}

export function shouldShowRunActivity(input: ThreadActivityInput): boolean {
  return isThreadBusy(input);
}

export function findRunActivity(
  parts: readonly ThreadActivityPart[] | undefined
): RunActivity | undefined {
  const visibleParts = parts ?? [];

  for (let index = visibleParts.length - 1; index >= 0; index -= 1) {
    const part = visibleParts[index];
    if (part?.type === "tool-call" && part.toolName && isUnfinishedToolCall(part)) {
      return { kind: "tool", toolName: part.toolName };
    }
  }

  const lastPart = lastMeaningfulPart(visibleParts);
  // Nothing is provably unfinished, but a trailing tool call still describes
  // what the run is on. Worst case this is one phrase stale — it cannot
  // affect whether the row renders.
  if (lastPart?.type === "tool-call" && lastPart.toolName) {
    return { kind: "tool", toolName: lastPart.toolName };
  }
  return lastPart?.type === "reasoning" ? { kind: "reasoning" } : undefined;
}

/** A subagent the run waits for: the `run_agent` call that started it and its description. */
export interface WaitedSubagent {
  toolCallId: string;
  description: string;
}

/**
 * The subagents the run waits for (CR-1's implicit join): every call of the step that has not
 * answered is a `run_agent` call, so the run itself does nothing until its children end. A
 * background child's call answers at once and is never waited for. Undefined while any other
 * call still runs, or once the calls have answered and the run goes on.
 */
export function findWaitedSubagents(
  parts: readonly ThreadActivityPart[] | undefined
): WaitedSubagent[] | undefined {
  const unfinished = (parts ?? []).filter(
    (part) => part.type === "tool-call" && isUnfinishedToolCall(part)
  );
  if (unfinished.length === 0) return undefined;
  if (unfinished.some((part) => part.toolName !== RUN_AGENT_TOOL_NAME)) return undefined;
  return unfinished.map((part) => ({
    toolCallId: part.toolCallId ?? "",
    description: readDescription(part.args)
  }));
}

function readDescription(args: unknown): string {
  if (typeof args !== "object" || args === null || !("description" in args)) return "";
  return typeof args.description === "string" ? args.description.trim() : "";
}

export function shouldShowCancelAction({
  conversationRunning,
  optimisticPending,
  threadRunning
}: ThreadActivityInput): boolean {
  return Boolean(conversationRunning || (optimisticPending && threadRunning));
}

/** The buttons at the composer's end: Send, Stop, or Stop with Send beside it. */
export type ComposerActions = "send" | "stop" | "stop-and-send";

/**
 * While a run goes, Send stays beside Stop as soon as there is something to send: the message
 * then waits in the queue. Without text, or where nothing can queue, Stop stands alone.
 */
export function composerActions(
  input: ThreadActivityInput & { canQueue: boolean; hasText: boolean }
): ComposerActions {
  if (!shouldShowCancelAction(input)) {
    return "send";
  }
  return input.canQueue && input.conversationRunning && input.hasText ? "stop-and-send" : "stop";
}

function isUnfinishedToolCall(part: ThreadActivityPart): boolean {
  const status = part.status?.type;
  if (status) {
    return status === "running" || status === "requires-action";
  }
  return part.result === undefined && part.isError !== true;
}

function lastMeaningfulPart(parts: readonly ThreadActivityPart[]): ThreadActivityPart | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part && part.type !== "indicator" && part.type !== "step-start") {
      return part;
    }
  }
  return undefined;
}
