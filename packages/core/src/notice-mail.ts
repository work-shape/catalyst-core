import type { ClientInstanceId, UserId } from "./ids";

/** References to Inbox notices awaiting a counts-only mail. No notice content or address. */
export interface NoticeMailStore {
  enqueue(input: {
    clientInstanceId: ClientInstanceId;
    noticeId: string;
    userId: UserId;
    dueAt: string;
  }): Promise<void>;
  /** Oldest due recipients first; one row per person, bounded by the operator's batch size. */
  dueRecipients(input: {
    clientInstanceId: ClientInstanceId;
    now: string;
    limit: number;
  }): Promise<UserId[]>;
  /** Counts only waiting Inbox notices due at the cutoff; later notices wait for the next. */
  countPending(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserId;
    before: string;
  }): Promise<number>;
  deferPending(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserId;
    before: string;
    dueAt: string;
  }): Promise<void>;
  removePending(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserId;
    before: string;
  }): Promise<void>;
}
