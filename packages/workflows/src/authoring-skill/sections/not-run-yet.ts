import { WORKFLOW_STEP_TYPES } from "@work-shape/catalyst-core";
import { WORKFLOW_EXECUTED_STEP_TYPES } from "../../definition";

/** The step types the file form holds and this engine does not run. */
export function workflowStepTypesNotRun(): string[] {
  const executed: readonly string[] = WORKFLOW_EXECUTED_STEP_TYPES;
  return WORKFLOW_STEP_TYPES.filter((type) => !executed.includes(type));
}

/** What the file form holds and this engine refuses with `not_supported_yet`. */
export const notRunYetSection = `## What this engine does not run yet

A definition that holds one of these is refused when it is saved, with the code
\`not_supported_yet\` and the path of the field:

- the step types ${workflowStepTypesNotRun()
  .map((type) => `\`${type}\``)
  .join(", ")};
- \`onFailure: workflow.<id>\` on the manifest;
- \`collect\` on a loop (EW-13);
- datasets in agent inputs (EW-14b).

Where the person asks for one of them, say that this release does not run it yet, and offer
what does: a loop for a list, a changing operation to keep what an item produces, one
operation that does the comparison in the outside system.`;
