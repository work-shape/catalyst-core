import type { ClientInstanceId, UserId } from "./ids";
import type { JsonObject } from "./json";

/** A person's failure notice of one Workflow that they have not marked handled yet. */
export interface OpenWorkflowFailureNotice {
  noticeId: string;
  /** What the notice holds now: its title, text and link. */
  payload: JsonObject;
  /** The failing runs counted into it since it was opened. */
  failures: number;
}

/**
 * Publication attribution and failure notices, without run values. Each root is counted once;
 * one person holds at most one unhandled failure notice per Workflow, which later roots update.
 */
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
  /**
   * In the transaction that writes the notice, after locking the ended root: false where the
   * root was counted already. `failures` is the root's own count.
   */
  markNotified(input: {
    clientInstanceId: ClientInstanceId;
    rootRunId: string;
    failures: number;
  }): Promise<boolean>;
  /**
   * The person's newest unhandled failure notice of the Workflow, locked with the transaction,
   * as are the person's failure notices of the Workflow, so two roots ending at once write one.
   */
  openFailureNotice(input: {
    clientInstanceId: ClientInstanceId;
    workflowId: string;
    userId: UserId;
  }): Promise<OpenWorkflowFailureNotice | undefined>;
  /**
   * Words the open notice anew and moves it to the top of its person's Inbox: its time becomes
   * `at`. False where it is no longer pending.
   */
  updateFailureNotice(input: {
    clientInstanceId: ClientInstanceId;
    noticeId: string;
    summary: string;
    payload: JsonObject;
    at: string;
  }): Promise<boolean>;
  /** Names the notice the root was counted into. */
  linkFailureNotice(input: {
    clientInstanceId: ClientInstanceId;
    rootRunId: string;
    noticeId: string;
  }): Promise<void>;
}
