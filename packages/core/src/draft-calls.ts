import type { ClientInstanceId } from "./ids";
import type { ISODateString } from "./time";

// "Run live once" (ADR-0031). A changing call of a draft is simulated. A holder of the write
// right on the draft switches one App action or one Workflow step of one draft revision live:
// the next call of it is made live, through the central policy like a call of a published
// revision. The call that takes the switch uses it up, and a switch whose draft has changed
// since is cleared, so an approval given for one draft never carries over to an edited one.

/** One switch: an action or a step of one draft revision, and who set it. */
export interface LiveOnceSwitch {
  /** The App or the Workflow, by kind, id and name. */
  asset: { kind: string; id: string; name: string };
  /** The draft revision it was set for. It covers no call of another revision. */
  revisionId: string;
  /** The App action or the Workflow step. */
  part: string;
  switchedBy: { id: string; label: string };
  switchedAt: ISODateString;
}

export interface LiveOnceSwitchStore {
  /**
   * Sets the switch, in place of one set before for the same part. Answers the switches of the
   * asset that were cleared because their revision is no longer the asset's draft.
   */
  switchOn(input: {
    clientInstanceId: ClientInstanceId;
    switch: LiveOnceSwitch;
  }): Promise<{ cleared: LiveOnceSwitch[] }>;
  /**
   * Takes the switch of one part of one draft revision, where it is set: of two calls that
   * ask at once, one takes it. Clears first every switch of the asset whose revision is no
   * longer its draft, and answers them.
   */
  take(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    revisionId: string;
    part: string;
  }): Promise<{ taken?: LiveOnceSwitch; cleared: LiveOnceSwitch[] }>;
}
