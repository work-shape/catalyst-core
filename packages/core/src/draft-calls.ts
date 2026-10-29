import type { ClientInstanceId } from "./ids";
import type { OperationTarget } from "./operation-runs";
import type { OperationEffect } from "./operations";
import type { ISODateString } from "./time";

// "Run live once" (ADR-0031). A changing call of a draft is simulated. A holder of the write
// right on the draft switches one App action or one Workflow step of one draft revision live
// for themselves: only their own calls use it. The next call of an App action is made live and
// uses the switch up. A Workflow step goes live for the whole next test run its owner starts:
// the first call of the step in that run binds the switch to the run, and every further call
// of the step in that run, each item of a loop, each retry, goes live too. Live calls go
// through the central policy like calls of a published revision. A switch nobody used is
// cleared once its draft changes, so an approval given for one draft never carries over.

/**
 * The test target of the asset a call of a draft reaches (ADR-0031): `present` where it
 * exists, such as a Data Store's test copy; `made_on_change` where it does not and a changing
 * call of a draft makes it. An asset without one has none.
 */
export type DraftTestTarget = "present" | "made_on_change";

/**
 * Where a call of a draft goes, by what it does, the called asset's test target and whether its
 * caller's "Run live once" covers it. A read goes to a test target that is present and live
 * otherwise. A change goes live where switched live, else to a test target, present or made by
 * the change, else nowhere: it is simulated. `runOperation()` decides a call by this rule, and
 * what shows a draft's parts says the same with it.
 */
export function draftCallTarget(input: {
  effect: OperationEffect;
  liveOnce: boolean;
  testTarget?: DraftTestTarget;
}): OperationTarget {
  if (input.effect === "reading") return input.testTarget === "present" ? "test" : "live";
  if (input.liveOnce) return "live";
  return input.testTarget === undefined ? "dry_run" : "test";
}

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
  /** The test run of a Workflow that took the switch, and when. Absent on a switch still set. */
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
   * a Workflow, the first call takes the switch and binds it to that run in one statement, and
   * every later call of the same run is answered that binding: `firstUse` tells the two apart.
   * A switch its owner sets again meanwhile is a new one, for their next run. Clears first every
   * switch of the asset whose revision is no longer its draft, and answers them.
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
  /**
   * One person's switches on the asset's current draft: each one set and not used yet, and of
   * each part the last test run that used one, with `usedByRunId` and `usedAt`. A part may
   * have both: a run took a switch, and its owner set a new one for the next run.
   */
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
