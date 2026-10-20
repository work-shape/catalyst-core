import type { StepReference } from "./module";

/** What the authoring skill says of a `workflow` step. */
export const workflowReference = {
  does: "Starts one child on its published revision, waits without a slot and returns its output.",
  fields: {
    workflow: "The child Workflow id; it lists the parent trigger.",
    input: "A mapping onto the child's inputs; its inputs and outputs supply the schemas.",
    key: "The child's run key: a list of literals and references, each a text or a number, which the engine joins with '/', such as [{ value: \"2026-09\" }, { ref: { step: each_client, path: number } }]. A run of the child that is open or done and has the key answers the step, which waits for it and does not own it; one that ended failed, cancelled or limit_reached gives its key up to a new run."
  }
} satisfies StepReference<"workflow">;
