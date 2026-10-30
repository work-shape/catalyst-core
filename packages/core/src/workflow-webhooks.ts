import type { ClientInstanceId } from "./ids";
import type { ISODateString } from "./time";

// The requests a Workflow's `webhook` trigger accepted (EW-4): one row per nonce, kept as long
// as a request with that nonce could still pass its timestamp check. The rows are what a
// replay is refused by and what the trigger's rate is counted from. A row holds no body and no
// header beside the nonce.

/** What `admit` answers: the request may start its run, or why it may not. */
export type WorkflowWebhookAdmission = "admitted" | "replayed" | "rate_limited";

export interface WorkflowWebhookStore {
  /**
   * Records one signed request of a Workflow's webhook, in the transaction that starts its run.
   * A nonce the Workflow accepted before answers `replayed`; `perMinute` accepted requests in
   * the minute before `receivedAt` answer `rate_limited`. Neither records anything. Rows older
   * than `forgetBefore` are removed first: their timestamp no longer passes.
   */
  admit(input: {
    clientInstanceId: ClientInstanceId;
    /** The asset of the Workflow: its rows go with it. */
    workflowAssetId: string;
    nonce: string;
    receivedAt: ISODateString;
    perMinute: number;
    forgetBefore: ISODateString;
  }): Promise<WorkflowWebhookAdmission>;
}
