import {
  WORKFLOW_LOOP_ITEM_FAILURE_MODES,
  WORKFLOW_LOOP_MAX_CONCURRENCY
} from "@work-shape/catalyst-core";
import { WORKFLOW_LOOP_MAX_ITEMS } from "../limits";
import type { StepReference } from "./module";

/** What the authoring skill says of a `loop` step. */
export const loopReference = {
  does: `Runs its \`steps\` in order once for each item of a list or dataset of at most ${WORKFLOW_LOOP_MAX_ITEMS} items, or the Workflow's \`limits.loopItems\`. Its output is the counts { total, done, failed } and never the results of its items: what an item produces is kept by a step inside the loop, such as a changing operation.`,
  fields: {
    continueAsNew:
      "{ position: <input field>, after?: <items per history>, cursor?: <item field path> }: continue on the published revision at a complete item boundary, carrying the next offset as that input field. Without after, continue at the run budget or deadline. Declare the position field in inputs; successors validate it again. With cursor, carry that field of the last completed item instead of an offset; a nonempty page continues after its loop and an empty page ends normally. Labels and onFailure stay those of the first run.",
    items:
      "A reference to the list or dataset: { step, path }, without `ref:` around it. The list is a field of the output of an earlier step.",
    steps:
      "The steps of one item, at least one. Inside them the id of the loop names the current item: { ref: { step: <loop id>, path: <field of the item> } }.",
    itemName: "What one item is called in a sentence, such as `client`. Optional.",
    itemLabel:
      "The dotted path of the field of an item that names it for a person on the run's page. Optional.",
    batch:
      "Rows per iteration when items is a dataset. Each iteration receives a dataset view at the loop reference with an empty path; no rows are copied. The loop item limit counts batches. Omit itemLabel for batches. Use code or a batch operation to process the view.",
    onItemFailure: `What a failed item does: ${WORKFLOW_LOOP_ITEM_FAILURE_MODES.map((mode) => `\`${mode}\``).join(" or ")}. \`stop\`, the default, fails the loop and the run at the first failed item; \`continue\` goes on and counts it under \`failed\`.`,
    concurrency: `How many items run at once, from 1 to ${WORKFLOW_LOOP_MAX_CONCURRENCY}. 1 when left out. It is an upper bound.`,
    collect: "Reserved for EW-13. Leave it out."
  }
} satisfies StepReference<"loop">;
