import { WORKFLOW_STEP_FILES_FOLDER } from "@work-shape/catalyst-core";
import {
  WORKFLOW_CODE_ERRORS,
  WORKFLOW_CODE_FILE_MAX_BYTES,
  WORKFLOW_CODE_LANGUAGES,
  WORKFLOW_STEP_FILES_MAX_BYTES
} from "../../code-step";

/** What the skill says of the step files: made from the rules and the bounds a save checks. */
function stepFilesReference(): string {
  const folder = WORKFLOW_STEP_FILES_FOLDER;
  const endings = Object.keys(WORKFLOW_CODE_LANGUAGES).map((ending) => `\`.${ending}\``);
  const languages = Object.entries(WORKFLOW_CODE_LANGUAGES)
    .map(([ending, { command }]) => `\`.${ending}\` with \`${command}\``)
    .join(", ");
  const code = WORKFLOW_CODE_ERRORS;
  return `## The step files of a code step

The scripts of a Workflow are part of its config, beside the manifest:

\`\`\`json
{
  "name": "<id of the Workflow>",
  "manifest": { "...": "the definition, with a step { type: code, file: classify.py, ... }" },
  "files": [{ "path": "${folder}/classify.py", "content": "<the whole text of the script>" }]
}
\`\`\`

- The \`path\` of a file is \`${folder}/\` and then what the step writes under \`file\`. A script
  may lie in a folder below \`${folder}/\`, such as \`${folder}/checks/total.py\`, which a step
  names as \`checks/total.py\`. Each part of the path starts with a letter, a digit or \`_\` and
  holds letters, digits, \`_\`, \`-\` and \`.\`. The path without \`${folder}/\` is at most 200
  characters long.
- A script ends in ${endings.join(", ")}: the runner runs ${languages}. No other file is taken:
  no data file, no note and no module that only another script loads.
- Every \`code\` step names a file that is in \`files\`, and every file in \`files\` is named by a
  step. Two steps may name the same file. No path is given twice.
- \`content\` is the whole script as text. One script is at most ${WORKFLOW_CODE_FILE_MAX_BYTES} bytes as UTF-8, and
  all files of a Workflow together at most ${WORKFLOW_STEP_FILES_MAX_BYTES} bytes.
- To add a \`code\` step, add the step to the manifest and its script to \`files\` in the same
  save. To change a script, change the \`content\` of its file. To remove a \`code\` step, remove
  its file as well, unless another step names it.

A script runs alone: its container holds this one script and the input, no other step file, no
network and no credential. The mapped \`input\` of the step is handed to it as JSON on its input
stream and as the file \`input.json\` in its working directory. Its result is the JSON it writes
to the file \`output.json\` there or, where it writes no such file, the JSON it prints. The
input is checked against \`inputSchema\` and the result against \`outputSchema\`. An exit code
other than 0 fails the step.

What is wrong with the files comes back from the check and from a refused save as issues, each
with the \`path\` of the value, a \`code\` and a sentence:

- \`${code.fileMissing}\` at \`steps.<step id>.file\`: no entry of \`files\` has the path the step names.
- \`${code.fileInvalid}\` at \`files[<position>].path\`: the path is not in \`${folder}/\`, is no script
  of the runner, or is given twice. At \`files[<position>].content\`: the content is no text
  that can be stored.
- \`${code.fileUnused}\` at \`files[<position>].path\`: no step names the file.
- \`${code.fileTooLarge}\` at \`steps.<step id>.file\`: the script is too large.
- \`${code.filesTooLarge}\` at \`files\`: the files are too large together.

A position counts from 0. A save that is refused stores nothing: the draft is what it was.

A read answers every script whole unless the config is too large for one answer. Such an answer
says where it was cut. It is no whole config: do not save from it, because the script that was
cut would be saved cut. Say so to the person.`;
}

export const stepFilesSection = stepFilesReference();
