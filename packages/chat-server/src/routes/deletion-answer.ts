import { DEFERRED } from "../http/route";
import type { DeletionOutcome } from "../subject-deletion";

/** The answer of a delete operation: its result, or `202` when the deletion's job took over. */
export function deletionAnswer<Result>(outcome: DeletionOutcome<Result>): Result | typeof DEFERRED {
  return outcome.status === "deleted" ? outcome.result : DEFERRED;
}
