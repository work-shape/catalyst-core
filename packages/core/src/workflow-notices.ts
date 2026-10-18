import type { ClientInstanceId, UserId } from "./ids";

/** Publication attribution and once-per-root failure notices, without run values. */
export interface WorkflowNoticesStore {
  recordPublisher(input: {
    clientInstanceId: ClientInstanceId;
    revisionId: string;
    userId: UserId;
  }): Promise<void>;
  publisher(input: {
    clientInstanceId: ClientInstanceId;
    revisionId: string;
  }): Promise<UserId | undefined>;
  failureCount(input: { clientInstanceId: ClientInstanceId; rootRunId: string }): Promise<number>;
  /** In the transaction that creates the notice, after locking the ended root. */
  markNotified(input: { clientInstanceId: ClientInstanceId; rootRunId: string }): Promise<boolean>;
}
