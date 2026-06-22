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
  parts?: readonly ThreadActivityPart[];
}

export interface ThreadActivityInput {
  conversationRunning?: boolean;
  optimisticPending?: boolean;
  threadRunning?: boolean;
  lastMessage?: ThreadActivityMessage;
}

export type PendingAssistantPresentation = "hidden" | "block-cursor" | "inline-cursor";

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

  if (lastAssistantPartShowsOwnActivity(input.lastMessage)) {
    return "hidden";
  }

  if (input.lastMessage?.role === "assistant" && assistantMessageHasVisibleContent(input.lastMessage)) {
    return "hidden";
  }

  return "block-cursor";
}

export function isComposerBlockedByBackgroundRun({
  conversationRunning,
  threadRunning
}: Pick<ThreadActivityInput, "conversationRunning" | "threadRunning">): boolean {
  return Boolean(conversationRunning && !threadRunning);
}

function lastAssistantPartShowsOwnActivity(message: ThreadActivityMessage | undefined): boolean {
  if (message?.role !== "assistant") {
    return false;
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
  return (message.parts ?? []).some((part) => {
    if (part.type === "text") {
      return part.text?.trim().length ? true : false;
    }
    return part.type !== "indicator" && part.type !== "step-start";
  });
}
