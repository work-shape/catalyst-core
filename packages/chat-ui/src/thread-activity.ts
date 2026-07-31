export interface ThreadActivityPart {
  type: string;
  text?: string;
  toolName?: string;
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

export function isComposerBlockedByActiveRun({
  conversationRunning
}: Pick<ThreadActivityInput, "conversationRunning">): boolean {
  return Boolean(conversationRunning);
}

export function shouldShowCancelAction({
  conversationRunning,
  optimisticPending,
  threadRunning
}: ThreadActivityInput): boolean {
  return Boolean(conversationRunning || (optimisticPending && threadRunning));
}

function isUnfinishedToolCall(part: ThreadActivityPart): boolean {
  const status = part.status?.type;
  if (status) {
    return status === "running" || status === "requires-action";
  }
  return part.result === undefined && part.isError !== true;
}

function lastMeaningfulPart(
  parts: readonly ThreadActivityPart[]
): ThreadActivityPart | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part && part.type !== "indicator" && part.type !== "step-start") {
      return part;
    }
  }
  return undefined;
}
