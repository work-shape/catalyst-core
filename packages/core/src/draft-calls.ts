import type { ClientInstanceId } from "./ids";
import type { ISODateString } from "./time";

// "Run live once" (ADR-0031). A changing call of a draft is simulated. A holder of the write
// right on the draft switches one App action or one Workflow step of one draft revision live
// for themselves: only their own calls use it. The next call of an App action is made live and
// uses the switch up. A Workflow step goes live for the whole next test run its owner starts:
// the first call of the step in that run binds the switch to the run, and every further call
// of the step in that run, each item of a loop, each retry, goes live too. Live calls go
// through the central policy like calls of a published revision. A switch nobody used is
// cleared once its draft changes, so an approval given for one draft never carries over.

/** One switch: an action or a step of one draft revision, whose it is, and its use. */
export interface LiveOnceSwitch {
  /** The App or the Workflow, by kind, id and name. */
  asset: { kind: string; id: string; name: string };
  /** The draft revision it was set for. It covers no call of another revision. */
  revisionId: string;
  /** The App action or the Workflow step. */
  part: string;
  /** The owner: the person who set it. Only their calls use it. */
  switchedBy: { id: string; label: string };
  switchedAt: ISODateString;
  /** The test run of a Workflow the switch was used by, and when. Absent while unused. */
  usedByRunId?: string;
  usedAt?: ISODateString;
}

export interface LiveOnceSwitchStore {
  /**
   * Sets the switch, in place of one its owner set before for the same part, used or not.
   * Answers the switches of the asset that were cleared because their revision is no longer
   * the asset's draft.
   */
  switchOn(input: {
    clientInstanceId: ClientInstanceId;
    switch: LiveOnceSwitch;
  }): Promise<{ cleared: LiveOnceSwitch[] }>;
  /**
   * Takes the switch the caller set on one part of one draft revision. Without `forRun` the
   * call uses it up: of two calls that ask at once, one takes it. With `forRun`, a test run of
   * a Workflow, the first call binds the switch to that run in one statement and every later
   * call of the same run is answered it again: `firstUse` tells the two apart. A switch bound
   * to another run is not taken. Clears first every unused switch of the asset whose revision
   * is no longer its draft, and answers them.
   */
  take(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    revisionId: string;
    part: string;
    /** The person calling: only a switch they set is taken. */
    switchedBy: string;
    forRun?: string;
    /** When the call takes it: the moment a bound switch was used. */
    at: ISODateString;
  }): Promise<{ taken?: LiveOnceSwitch; firstUse: boolean; cleared: LiveOnceSwitch[] }>;
  /** The switches one person set on the asset's current draft, used or not, by part. */
  list(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    switchedBy: string;
  }): Promise<LiveOnceSwitch[]>;
  /**
   * Clears every switch of the asset whose revision is no longer its draft, and answers them.
   * Asked before a discard, which makes an earlier revision the draft again: a switch left
   * from that revision would otherwise apply once more.
   */
  clearStale(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
  }): Promise<LiveOnceSwitch[]>;
}
