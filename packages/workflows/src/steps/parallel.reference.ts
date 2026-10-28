import type { StepReference } from "./module";

export const parallelReference = {
  does: "Runs independent branches at once and joins after all end. Returns one field per branch id containing that branch's last output, or null for an empty branch. A failed branch skips its remaining steps; other branches finish before the parallel step fails. Cancelling the run stops further work.",
  fields: {
    branches:
      "A list of { id, name, steps }. Each branch id is unique here; every step id is unique in the whole definition. Steps inside each branch run in order and may reference earlier steps in that branch or before the block, never a sibling branch. Reference this block's output after the join.",
    concurrency:
      "Optional positive integer limiting active branches. Omit it to start all branches together, within the Workflow and instance step slots."
  }
} satisfies StepReference<"parallel">;
