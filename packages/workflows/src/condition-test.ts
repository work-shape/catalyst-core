import { isDeepStrictEqual } from "node:util";
import type { JsonValue, WorkflowConditionTest } from "@work-shape/catalyst-core";
import { WorkflowStepFailure } from "./step-failure";

/** JSON equality is structural; ordered comparisons take numbers without coercion. */
export function conditionHolds(actual: JsonValue, test: WorkflowConditionTest): boolean {
  if (test.op === "equals") return isDeepStrictEqual(actual, test.value);
  if (test.op === "not_equals") return !isDeepStrictEqual(actual, test.value);
  if (typeof actual !== "number" || typeof test.value !== "number")
    throw new WorkflowStepFailure("condition_invalid", "An ordered comparison needs two numbers");
  switch (test.op) {
    case "greater_than":
      return actual > test.value;
    case "greater_than_or_equal":
      return actual >= test.value;
    case "less_than":
      return actual < test.value;
    case "less_than_or_equal":
      return actual <= test.value;
    default:
      throw new WorkflowStepFailure("condition_invalid", "The condition comparison is unknown");
  }
}
