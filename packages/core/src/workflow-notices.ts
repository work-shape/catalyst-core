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
  /**
   * Whether a credential made the revision live, by the newest publication of it (WF-OUT): a
   * personal API key, its Inbox confirmation, a Service Principal's credential or a run. A
   * person's publish of the same revision makes it the person's again. A revision with no
   * publication recorded, published before publications were, counts as a person's.
   */
  publishedByCredential(input: {
    clientInstanceId: ClientInstanceId;
    revisionId: string;
  }): Promise<boolean>;
  failureCount(input: { clientInstanceId: ClientInstanceId; rootRunId: string }): Promise<number>;
  /** In the transaction that creates the notice, after locking the ended root. */
  markNotified(input: { clientInstanceId: ClientInstanceId; rootRunId: string }): Promise<boolean>;
}
