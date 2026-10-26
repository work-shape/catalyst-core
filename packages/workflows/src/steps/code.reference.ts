import { WORKFLOW_STEP_FILES_FOLDER } from "@work-shape/catalyst-core";
import type { StepReference } from "./module";

/** What the authoring skill says of a `code` step. */
export const codeReference = {
  does: `Runs one script of the Workflow's step files on its input as JSON and returns JSON. The step names an entry in its revision tree. See 'The step files of a code step' for what a file is, what a script is handed and how its issues come back.`,
  fields: {
    entry:
      "The .py, .js or .mjs entry path from the Workflow tree root. The whole revision tree is available read-only, with the root on the module path.",
    file: `Deprecated for one release: the path relative to \`${WORKFLOW_STEP_FILES_FOLDER}/\`. This alias keeps relative input.json/output.json in writable scratch and imports from the read-only revision tree. Use entry for new steps.`,
    input: "The mapping onto the script's input. See 'Mappings and references'.",
    inputSchema: "The JSON Schema of the input the script is handed. Required.",
    outputSchema: "The JSON Schema of what the script returns. Required."
  }
} satisfies StepReference<"code">;
