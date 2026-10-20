import type { StepReference } from "./module";

/** What the authoring skill says of a `output` step. */
export const outputReference = {
  does: "The result of the run. It is the last step, and its mapped value is checked against the definition's `outputs`.",
  fields: {
    input: "The mapping onto the fields of `outputs`. See 'Mappings and references'."
  }
} satisfies StepReference<"output">;
