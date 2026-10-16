import { DELETION_STATES } from "@work-shape/catalyst-core";
import type { DeletionOutcome } from "../deletion/subject-deletion";
import { DEFERRED } from "../http/route";

/** The answer of a delete operation: its result, or `202` when the deletion's job took over. */
export function deletionAnswer<Result>(outcome: DeletionOutcome<Result>): Result | typeof DEFERRED {
  return outcome.status === "deleted" ? outcome.result : DEFERRED;
}

export function deletionState(outcome: DeletionOutcome<unknown>): {
  state: (typeof DELETION_STATES)[number];
} {
  return { state: outcome.status === "deleted" ? "deleted" : "deleting" };
}
