import type { ClientInstanceId } from "./ids";
import type { OperationTarget } from "./operation-runs";
import type { OperationEffect } from "./operations";
import type { ISODateString } from "./time";

// "Run live once" (ADR-0031). A changing call of a draft is simulated. A holder of the write
// right on the draft switches one App action or one Workflow step of one draft revision live:
// the next call of it that the same person makes is made live, through the central policy like
// a call of a published revision. Another person's call stays simulated. The call that takes
// the switch uses it up, and a switch whose draft has changed since is cleared, so an approval
// given for one draft never carries over to an edited one.

/**
 * Where a call of a draft goes, by what it does and whether its caller's "Run live once"
 * covers it: a read goes live, a change is simulated unless switched live. `runOperation()`
 * decides a call by this rule, and what shows a draft's parts says the same with it. DT-2 and
 * DT-3 add the test target of the called asset here, which every call of a draft then reaches.
 */
export function draftCallTarget(input: {
  effect: OperationEffect;
  liveOnce: boolean;
}): OperationTarget {
  return input.effect === "reading" || input.liveOnce ? "live" : "dry_run";
}

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
   * Takes the switch of one part of one draft revision, where `takenBy` set it: of two calls
   * that ask at once, one takes it, and a call of anybody else takes none. Clears first every
   * switch of the asset whose revision is no longer its draft, and answers them.
   */
  take(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    revisionId: string;
    part: string;
    /** The id of the person calling. */
    takenBy: string;
  }): Promise<{ taken?: LiveOnceSwitch; cleared: LiveOnceSwitch[] }>;
  /**
   * The switches of one draft revision of an asset that are not used yet, one per part at
   * most. Reads only: a switch of an earlier revision is left for the next write to clear.
   */
  list(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    revisionId: string;
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
