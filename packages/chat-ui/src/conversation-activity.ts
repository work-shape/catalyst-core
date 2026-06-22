export type ConversationActivityStatus = "running" | "failed" | "idle";

export interface ConversationActivity {
  status: ConversationActivityStatus;
  unread: boolean;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  runId?: string;
}

export function isConversationRunning(activity: ConversationActivity | undefined): boolean {
  return activity?.status === "running";
}

export function shouldRefreshConversationMessagesOnSelect(
  activity: ConversationActivity | undefined
): boolean {
  return Boolean(activity?.unread || isConversationRunning(activity));
}
