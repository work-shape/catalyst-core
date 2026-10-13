import {
  WORKFLOW_LOOP_ITEM_FAILURE_MODES,
  WORKFLOW_LOOP_MAX_CONCURRENCY,
  WORKFLOW_STEP_FILES_FOLDER,
  WORKFLOW_STEP_TYPES,
  type ShippedSkill,
  type WorkflowStep
} from "@vivd-catalyst/core";
import {
  WORKFLOW_CODE_ERRORS,
  WORKFLOW_CODE_FILE_MAX_BYTES,
  WORKFLOW_CODE_LANGUAGES,
  WORKFLOW_STEP_FILES_MAX_BYTES
} from "./code-step";
import { WORKFLOW_EXECUTED_STEP_TYPES } from "./definition";
import {
  WORKFLOW_DEFINITION_MAX_STEPS,
  WORKFLOW_LOOP_MAX_ITEMS,
  WORKFLOW_STEP_DATA_MAX_BYTES
} from "./limits";

// The skill an agent reads before it changes the definition of a Workflow. It ships with the
// engine and is no asset: what it says of the step types is made from the list of the types
// this engine runs and from the fields the step type holds, so a release that runs another
// step, or gives one another field, does not build until this file says what it is.

export const WORKFLOW_AUTHORING_SKILL_NAME = "workflow-authoring";

type ExecutedStepType = (typeof WORKFLOW_EXECUTED_STEP_TYPES)[number];
type FieldsOf<Type extends ExecutedStepType> = Exclude<
  keyof Extract<WorkflowStep, { type: Type }>,
  "type" | "id" | "name" | "description"
>;

/**
 * What the skill says of each step type: one sentence on what it does, and one per field. A
 * field the engine reads and does not run yet says so. The type makes every executed step
 * type and every field of it a required key.
 */
const STEP_REFERENCE: {
  [Type in ExecutedStepType]: { does: string; fields: Record<FieldsOf<Type>, string> };
} = {
  trigger: {
    does: "Starts the run. It is always the first step, and a definition has exactly one. Its output is { input, startedAt, trigger, scheduledFor }, where `input` is the run's input, checked against the definition's `inputs`.",
    fields: {
      triggers:
        'A list with at least one of { kind: manual } (a person or a call starts the run) and { kind: schedule, cron: "<five fields>" } (the run starts at the due times, read in the instance\'s time zone). `kind: parent`, and `missed` and `overlap` with other values than `last` and `skip`, are not run yet.'
    }
  },
  operation: {
    does: "Calls one operation by its name, as the service principal the Workflow runs as. Its output is what the operation answered.",
    fields: {
      operation:
        "The full name of the operation, such as `connection.<connection>.<operation>`. Ask the tool that lists the callable operations for the names and their input schemas; do not guess one.",
      input:
        "The mapping onto the operation's input: one entry per field of its input schema. See 'Mappings and references'.",
      dataset: "Not run yet. Leave it out.",
      paginate: "Not run yet. Leave it out."
    }
  },
  loop: {
    does: `Runs its \`steps\` in order once for each item of a list of at most ${WORKFLOW_LOOP_MAX_ITEMS} items. Its output is the counts { total, done, failed } and never the results of its items: what an item produces is kept by a step inside the loop, such as a changing operation.`,
    fields: {
      items:
        "A reference to the list: { step, path }, without `ref:` around it. The list is a field of the output of an earlier step.",
      steps:
        "The steps of one item, at least one. Inside them the id of the loop names the current item: { ref: { step: <loop id>, path: <field of the item> } }.",
      itemName: "What one item is called in a sentence, such as `client`. Optional.",
      itemLabel:
        "The dotted path of the field of an item that names it for a person on the run's page. Optional.",
      onItemFailure: `What a failed item does: ${WORKFLOW_LOOP_ITEM_FAILURE_MODES.map((mode) => `\`${mode}\``).join(" or ")}. \`stop\`, the default, fails the loop and the run at the first failed item; \`continue\` goes on and counts it under \`failed\`.`,
      concurrency: `How many items run at once, from 1 to ${WORKFLOW_LOOP_MAX_CONCURRENCY}. 1 when left out. It is an upper bound.`,
      collect: "Not run yet. Leave it out."
    }
  },
  code: {
    does: `Runs one script of the Workflow's step files on its input as JSON and returns JSON. The script is one entry of the config's \`files\`, and the step names it. See 'The step files of a code step' for what a file is, what a script is handed and how its issues come back.`,
    fields: {
      file: `The path of the script inside the folder \`${WORKFLOW_STEP_FILES_FOLDER}/\`, written without the folder: \`classify.py\` names the entry of \`files\` whose \`path\` is \`${WORKFLOW_STEP_FILES_FOLDER}/classify.py\`. A step whose file is no entry of \`files\` is refused.`,
      input: "The mapping onto the script's input. See 'Mappings and references'.",
      inputSchema: "The JSON Schema of the input the script is handed. Required.",
      outputSchema: "The JSON Schema of what the script returns. Required."
    }
  },
  output: {
    does: "The result of the run. It is the last step, and its mapped value is checked against the definition's `outputs`.",
    fields: {
      input: "The mapping onto the fields of `outputs`. See 'Mappings and references'."
    }
  }
};

/** A definition the examples of the skill show. `tests/fixtures/workflows` holds each as a file. */
const EXAMPLES: { title: string; yaml: string }[] = [
  {
    title: "Read from a Connection and return a part of the answer",
    yaml: `id: top-customers
name: Top customers
description: Reads the customers with the highest revenue from the sample system.
runAs: workflow-runner
inputs:
  type: object
  properties:
    limit:
      type: integer
  required: [limit]
  additionalProperties: false
outputs:
  type: object
  properties:
    customers:
      type: array
  required: [customers]
steps:
  - id: start
    name: Start by hand
    type: trigger
    triggers:
      - kind: manual
  - id: top
    name: Read the top customers
    type: operation
    operation: connection.sample.top_customers
    input:
      limit:
        ref: { step: start, path: input.limit }
  - id: result
    name: Result
    type: output
    input:
      customers:
        ref: { step: top, path: structuredContent.rows }`
  },
  {
    title: "A loop that makes one changing call per item and returns its counts",
    yaml: `id: notify-clients
name: Notify clients
runAs: workflow-runner
inputs:
  type: object
  properties:
    note:
      type: string
  required: [note]
outputs:
  type: object
steps:
  - id: start
    name: Start by hand
    type: trigger
    triggers:
      - kind: manual
  - id: clients
    name: Read the clients
    type: operation
    operation: connection.crm.echo
    input:
      text:
        ref: { step: start, path: input.note }
  - id: each_client
    name: For each client
    type: loop
    items: { step: clients, path: clients }
    itemLabel: id
    onItemFailure: continue
    steps:
      - id: send
        name: Send the note
        type: operation
        operation: connection.crm.write
        input:
          client:
            ref: { step: each_client, path: id }
          note:
            ref: { step: start, path: input.note }
  - id: result
    name: Result
    type: output
    input:
      sent:
        ref: { step: each_client, path: done }
      failed:
        ref: { step: each_client, path: failed }`
  },
  {
    title: "A schedule and a literal value in a mapping",
    yaml: `id: nightly-check
name: Nightly check
runAs: workflow-runner
inputs:
  type: object
outputs:
  type: object
  properties:
    month:
      type: string
steps:
  - id: start
    name: Every night at two, or by hand
    type: trigger
    triggers:
      - kind: schedule
        cron: "0 2 * * *"
      - kind: manual
  - id: read
    name: Read the open items
    type: operation
    operation: connection.crm.echo
    input:
      text:
        value: open-items
  - id: result
    name: Result
    type: output
    input:
      month:
        ref: { step: start, path: startedAt }`
  }
];

/** The examples of the skill, as the files they are written as. A test parses each. */
export const WORKFLOW_AUTHORING_EXAMPLES: readonly { title: string; yaml: string }[] = EXAMPLES;

function stepReference(): string {
  return WORKFLOW_EXECUTED_STEP_TYPES.map((type) => {
    const { does, fields } = STEP_REFERENCE[type];
    const lines = Object.entries(fields).map(([field, says]) => `- \`${field}\`: ${says}`);
    return [`### \`type: ${type}\``, does, ...lines].join("\n");
  }).join("\n\n");
}

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

/** The step types the file form holds and this engine does not run. */
export function workflowStepTypesNotRun(): string[] {
  const executed: readonly string[] = WORKFLOW_EXECUTED_STEP_TYPES;
  return WORKFLOW_STEP_TYPES.filter((type) => !executed.includes(type));
}

function content(): string {
  const examples = EXAMPLES.map(
    ({ title, yaml }) => `### ${title}\n\n\`\`\`yaml\n${yaml}\n\`\`\``
  ).join("\n\n");
  return `# Writing the definition of a Workflow

Read this before you change the definition of a Workflow. It says what a definition holds, what
the engine of this release runs, and how to save a change safely.

## How you work on a definition

You are given tools that are bound to the Workflow this conversation is about.

1. Read the definition. You get its \`config\`, the \`revision\` it is at and whether you see the
   draft or the published revision. The config is \`{ name, manifest, files }\`: \`manifest\` is
   the definition, and \`files\` is the list of the scripts its \`code\` steps run, each
   \`{ path, content }\`. A Workflow without a \`code\` step has no \`files\`, or an empty list.
2. Change the \`manifest\` and the \`files\` in your answer to the read, never from memory. Keep
   everything you were not asked to change exactly as it is, the ids of the steps and the
   content of every script among it.
3. Check the whole config before you save. Each issue names the path of a value and says what
   is wrong with it. Correct it and check again until no issue is left.
4. Save the whole config, every file with its whole content among it, with the revision you
   read as \`expectedRevision\`. A save replaces the draft: a file you leave out is gone from
   it, and a save that leaves out a file a step names is refused. A save moves the draft
   only: it publishes nothing and starts nothing, and the published revision keeps running as
   it is. A person publishes the draft when they have looked at it.
5. A save that answers a conflict means somebody saved since you read. Read again, make your
   change on what is there now, and save with the new revision.

Tell the person what you changed, in a few plain sentences, and that the change is a draft
until they publish it.

## What a manifest is

\`manifest\` is the file \`workflow.yaml\` as an object. It holds these fields and no other:

- \`id\`: the id of the Workflow: lowercase letters, digits, \`_\` and \`-\`. It is the \`name\` of
  the config. Never change it.
- \`name\`: what a person calls the Workflow. \`description\`: one or two plain sentences, optional.
- \`runAs\`: the name of the service principal every step acts as. Its rights decide what a step
  may call. Do not change it unless the person asks: a publish checks whether its publisher
  may let a Workflow act as that principal.
- \`inputs\`: the JSON Schema of the input a run is started with. An object schema.
- \`outputs\`: the JSON Schema of the result of a run. An object schema.
- \`steps\`: the steps in the order they run, at most ${WORKFLOW_DEFINITION_MAX_STEPS} with the steps of loops counted.
  The first is the \`trigger\`, the last the \`output\`.

Every step has an \`id\` (lowercase letters, digits, \`_\` and \`-\`, unique in the whole
definition), a \`name\` a person reads on the run's page, an optional \`description\` and a \`type\`.
A step holds the fields of its type and no other: a field the type does not have is refused.

There is no wiring between steps. They run from top to bottom, and a loop holds its own steps.

## The step types this engine runs

${stepReference()}

${stepFilesReference()}

## Mappings and references

The \`input\` of a step is a mapping: one entry per field, and each entry is exactly one of

- \`value: <any JSON>\`: a literal, and
- \`ref: { step: <id of an earlier step>, path: <dotted path into its output> }\`: a field of
  what an earlier step answered.

A mapping holds no expression, no template and no arithmetic. What needs computing is done by
the operation a step calls.

- A reference names a step that ran before the step it stands in. A step outside a loop cannot
  name a step inside it.
- The path is dotted, such as \`rows\` or \`customer.address.city\`. An empty path is the whole
  output.
- The run's input is read from the trigger: \`{ step: <trigger id>, path: input.<field> }\`.
- Inside a loop, the id of the loop is the current item: \`{ step: <loop id>, path: <field> }\`.
  After the loop the same id is its counts: \`total\`, \`done\`, \`failed\`.
- What an operation answers decides the path into its output. Where you do not know the shape,
  say so to the person instead of guessing a path: a wrong path fails the run, not the save.

The input and the output of one step may each be at most ${WORKFLOW_STEP_DATA_MAX_BYTES} bytes as JSON.

## What this engine does not run yet

A definition that holds one of these is refused when it is saved, with the code
\`not_supported_yet\` and the path of the field:

- the step types ${workflowStepTypesNotRun()
    .map((type) => `\`${type}\``)
    .join(", ")};
- \`labels\`, \`onFailure\`, \`retention\` and \`types\` on the manifest;
- \`dataset\` and \`paginate\` on an operation step, and \`collect\` on a loop;
- the trigger \`parent\`.

Where the person asks for one of them, say that this release does not run it yet, and offer
what does: a loop for a list, a changing operation to keep what an item produces, one
operation that does the comparison in the outside system.

## Examples

${examples}
`;
}

/** The skill as a conversation about a Workflow is offered it. */
export const workflowAuthoringSkill: ShippedSkill = {
  name: WORKFLOW_AUTHORING_SKILL_NAME,
  title: "Writing a Workflow",
  description:
    "How to read, change, check and save the definition of a Workflow: what a manifest holds, the step types this engine runs, the scripts of its code steps, references between steps and what is not run yet. Read it before you change a Workflow.",
  content: content()
};
