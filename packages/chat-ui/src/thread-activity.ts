export interface ThreadActivityPart {
  type: string;
  text?: string;
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
  lastMessage?: ThreadActivityMessage;
}

export type PendingAssistantPresentation = "hidden" | "block-cursor" | "inline-cursor";
export type ActiveAssistantCursorPlacement = "hidden" | "before" | "after";

export function shouldShowToolGroupActivity(input: {
  activeRunMessage: boolean;
  containsActivePart: boolean;
}): boolean {
  return Boolean(input.activeRunMessage && input.containsActivePart);
}

export function toolGroupActivityLabel(input: {
  active: boolean;
  activityLabel?: string;
  countLabel: string;
}): string {
  return input.active && input.activityLabel
    ? `${input.countLabel} · ${input.activityLabel}`
    : input.countLabel;
}

export function findLastVisibleAssistantPartIndex(
  parts: readonly ThreadActivityPart[]
): number | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part && partHasVisibleAssistantContent(part)) {
      return index;
    }
  }
  return undefined;
}

export function activeAssistantCursorPlacement(input: {
  activeLastPart?: boolean;
  toolActivityRunning?: boolean;
  running: boolean;
  parts: readonly ThreadActivityPart[];
}): ActiveAssistantCursorPlacement {
  if (!input.running || input.toolActivityRunning) {
    return "hidden";
  }
  if (input.activeLastPart) {
    if (lastPartShowsActiveRunActivity(input.parts)) {
      return "hidden";
    }
    return input.parts.some(partHasVisibleAssistantContent) ? "after" : "before";
  }
  if (input.parts.some(partShowsOwnActivity)) {
    return "hidden";
  }
  return input.parts.some(partHasVisibleAssistantContent) ? "after" : "before";
}

export function isThreadBusy({
  conversationRunning,
  optimisticPending,
  threadRunning
}: ThreadActivityInput): boolean {
  return Boolean(conversationRunning || optimisticPending || threadRunning);
}

export function shouldShowPendingAssistantMessage(input: ThreadActivityInput): boolean {
  return pendingAssistantPresentation(input) === "block-cursor";
}

export function pendingAssistantPresentation(input: ThreadActivityInput): PendingAssistantPresentation {
  if (!isThreadBusy(input)) {
    return "hidden";
  }

  if (input.threadRunning) {
    return "hidden";
  }

  if (lastAssistantPartShowsOwnActivity(input.lastMessage)) {
    return "hidden";
  }

  if (input.lastMessage?.role === "assistant" && assistantMessageHasVisibleContent(input.lastMessage)) {
    return "hidden";
  }

  return "block-cursor";
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
}: Pick<ThreadActivityInput, "conversationRunning" | "optimisticPending" | "threadRunning">): boolean {
  return Boolean(conversationRunning || (optimisticPending && threadRunning));
}

function lastAssistantPartShowsOwnActivity(message: ThreadActivityMessage | undefined): boolean {
  if (message?.role !== "assistant") {
    return false;
  }
  if (message.status?.type === "running") {
    return true;
  }

  const lastPart = message.parts?.at(-1);
  if (lastPart?.type === "indicator") {
    return true;
  }
  if (lastPart?.type === "reasoning" && lastPart.status?.type === "running") {
    return true;
  }
  return Boolean(lastPart?.type === "text" && lastPart.status?.type === "running" && lastPart.text?.trim().length);
}

function assistantMessageHasVisibleContent(message: ThreadActivityMessage): boolean {
  return (message.parts ?? []).some(partHasVisibleAssistantContent);
}

function partShowsOwnActivity(part: ThreadActivityPart): boolean {
  if (part.type === "reasoning" && part.status?.type === "running") {
    return true;
  }
  if (part.type === "text") {
    return part.status?.type === "running" && Boolean(part.text?.trim().length);
  }
  return part.status?.type === "running";
}

function lastPartShowsActiveRunActivity(parts: readonly ThreadActivityPart[]): boolean {
  const lastPart = parts.at(-1);
  if (lastPart?.type === "reasoning") {
    return true;
  }
  return Boolean(lastPart?.type === "text" && lastPart.text?.trim().length);
}

export function partHasVisibleAssistantContent(part: ThreadActivityPart): boolean {
  if (part.type === "text" || part.type === "reasoning") {
    return Boolean(part.text?.trim().length);
  }
  return part.type !== "indicator" && part.type !== "step-start";
}
