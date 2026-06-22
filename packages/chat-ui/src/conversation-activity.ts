export type ConversationActivityStatus = "running" | "failed" | "idle";

export interface ConversationActivity {
  status: ConversationActivityStatus;
  unread: boolean;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}
