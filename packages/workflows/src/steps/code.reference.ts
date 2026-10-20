import { WORKFLOW_STEP_FILES_FOLDER } from "@work-shape/catalyst-core";
import type { StepReference } from "./module";

/** What the authoring skill says of a `code` step. */
export const codeReference = {
  does: `Runs one script of the Workflow's step files on its input as JSON and returns JSON. The script is one entry of the config's \`files\`, and the step names it. See 'The step files of a code step' for what a file is, what a script is handed and how its issues come back.`,
  fields: {
    file: `The path of the script inside the folder \`${WORKFLOW_STEP_FILES_FOLDER}/\`, written without the folder: \`classify.py\` names the entry of \`files\` whose \`path\` is \`${WORKFLOW_STEP_FILES_FOLDER}/classify.py\`. A step whose file is no entry of \`files\` is refused.`,
    input: "The mapping onto the script's input. See 'Mappings and references'.",
    inputSchema: "The JSON Schema of the input the script is handed. Required.",
    outputSchema: "The JSON Schema of what the script returns. Required."
  }
} satisfies StepReference<"code">;
