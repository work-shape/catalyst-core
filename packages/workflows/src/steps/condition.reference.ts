import type { StepReference } from "./module";

export const conditionReference = {
  does: "Tests an earlier output and runs only the chosen branch. Returns { taken: 'then' | 'else', result }, where result is the last step's output, or null for an empty branch.",
  fields: {
    when: "{ ref: { step, path }, op, value }. equals and not_equals compare JSON structurally. greater_than, greater_than_or_equal, less_than and less_than_or_equal compare numbers without coercion. A missing reference fails the step.",
    then: "Steps run in order when the test holds. May be empty.",
    else: "Steps run in order when the test does not hold. Optional; an omitted branch is empty."
  }
} satisfies StepReference<"condition">;
