import type { WorkflowRunnerPackage } from "./runner-packages";
import {
  WORKFLOW_LOOP_ITEM_FAILURE_MODES,
  WORKFLOW_LOOP_MAX_CONCURRENCY,
  WORKFLOW_STEP_FILES_FOLDER,
  WORKFLOW_STEP_TYPES,
  type ShippedSkill,
  type WorkflowStep
} from "@work-shape/catalyst-core";
import {
  WORKFLOW_CODE_ERRORS,
  WORKFLOW_CODE_FILE_MAX_BYTES,
  WORKFLOW_CODE_LANGUAGES,
  WORKFLOW_STEP_FILES_MAX_BYTES
} from "./code-step";
import { WORKFLOW_RULES_REVISION_INPUT } from "./child-rules-revision";
import { WORKFLOW_EXECUTED_STEP_TYPES } from "./definition";
import {
  WORKFLOW_DEFINITION_MAX_STEPS,
  WORKFLOW_LOOP_MAX_ITEMS,
  WORKFLOW_RUN_MAX_DURATION_MS,
  WORKFLOW_RUN_MAX_STEP_RUNS,
  WORKFLOW_STEP_DATA_MAX_BYTES
} from "./limits";
import { workflowDurationText } from "./run-limits";

// The skill an agent reads before it changes the definition of a Workflow. It ships with the
// engine, and the release seed stores it as a read-only skill: what it says of the step types
// is made from the list of the types this engine runs and from the fields the step type holds,
// so a release that runs another step, or gives one another field, does not build until this
// file says what it is.

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
        'A nonempty list of { kind: manual } (a person or a call starts it), { kind: schedule, cron: "<five fields>", timeZone: "<IANA zone>" } (a wall-clock time in that zone), or { kind: parent } (a workflow step starts it). With parent alone, only another Workflow starts it. Values of missed and overlap other than last and skip are not run yet.'
    }
  },
  operation: {
    does: "Calls one operation by its name, as the account the Workflow runs as. Its output is what the operation answered. `mail.send` sends one e-mail as the instance's system sender and exists only where the instance sends mail: ask `platform.assets.operations` for it by exact `name` before you use it. Its `to`, `cc` and `bcc` take addresses, { user: id } and { workspace: id }; `subject` is one line; `body` is Markdown, where HTML and images are shown as text or dropped. It mails people of the instance and addresses in the domains the instance allows; a literal address outside them is refused at save. Its output holds the counts and the message id, never an address.",
    fields: {
      operation:
        "The full name of the operation, such as `connection.<connection>.<operation>`. Ask `platform.assets.operations` for the names and input schemas; filter by exact `name` or a `prefix` such as `connection.crm.` or `data_store.orders.`. Each page has at most 200 operations: pass `nextCursor` as `cursor` with the same filters until it is absent before concluding an operation does not exist. Do not guess a name. To run another Workflow and wait for its result, use a `workflow` step, not `workflow.<name>.start` here.",
      input:
        "The mapping onto the operation's input: one entry per field of its input schema. See 'Mappings and references'.",
      dataset:
        "Use { at: <dotted path> } to replace an object-row list in the answer with a dataset reference at the same path. Rows are streamed into the files store; the step record holds only the reference. See Datasets.",
      paginate:
        "Use true to take the reading Connection operation's paging, or an object to override its fields. Requires dataset.at. See Datasets.",
      timeout:
        "Only for an operation whose work ends after the call, such as the sync of a Knowledge Base: how long the step waits for it, such as `30m`, `6h` or `3d`; 6h when left out. The wait counts toward no limit of the run. At it the step fails with `operation_still_running` and the work goes on."
    }
  },
  workflow: {
    does: "Starts one child on its published revision, waits without a slot and returns its output.",
    fields: {
      workflow: "The child Workflow id; it lists the parent trigger.",
      input: "A mapping onto the child's inputs; its inputs and outputs supply the schemas.",
      key: "The child's run key: a list of literals and references, each a text or a number, which the engine joins with '/', such as [{ value: \"2026-09\" }, { ref: { step: each_client, path: number } }]. A run of the child that is open or done and has the key answers the step, which waits for it and does not own it; one that ended failed, cancelled or limit_reached gives its key up to a new run."
    }
  },
  loop: {
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
  notify: {
    does: "Leaves a notice in each active recipient's Inbox. With mail, queues a counts-only digest and a link; no title, text, client name or finding leaves by mail. Use notify to tell people of the instance that something needs them; for an e-mail with content, or to an address outside the instance, use an `operation` step on `mail.send` where the instance has it. A test simulates this changing step: its result shows wouldHaveDone with the intended recipients and frozen content; it sends no Inbox item or mail.",
    fields: {
      to: "Instance user ids under users and Shared Workspace ids under workspaces (their active members). For 'me', use platform.context caller.id. For a name or email, call platform.context with person and use the returned people match; ask which person if ambiguous, never ask the person to type an id. No free e-mail address.",
      channels: "[inbox], or [inbox, mail]. Every notice has an Inbox item.",
      title: "A mapping { value: text } or { ref: { step, path } }; Inbox only, one line.",
      text: "A mapping { value: text } or { ref: { step, path } }; Inbox only, one paragraph.",
      link: "{ kind: run } (default), or { kind: app, workspaceId: id, app: id }. Ids only."
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

const REVISION = WORKFLOW_RULES_REVISION_INPUT;
const ECHO = 'json.dump(json.load(open("input.json")), open("output.json", "w"))';

/** The steps of a parent that keeps the rules revision in one value. A test parses them. */
const RULES_REVISION_STEPS = `- id: rules
  name: Rules revision
  type: code
  file: rules.py
  input:
    ${REVISION}: { value: rules-4 }
  inputSchema:
    { type: object, properties: { ${REVISION}: { type: string } }, required: [${REVISION}] }
  outputSchema:
    { type: object, properties: { ${REVISION}: { type: string } }, required: [${REVISION}] }
- id: each_client
  name: For each client
  type: loop
  items: { step: start, path: input.clients }
  steps:
    - id: check
      name: Check the client
      type: workflow
      workflow: check-client
      input:
        client: { ref: { step: each_client, path: id } }
        ${REVISION}: { ref: { step: rules, path: ${REVISION} } }
      key:
        - { value: "2026-09" }
        - { ref: { step: rules, path: ${REVISION} } }
        - { ref: { step: each_client, path: id } }`;

/** The step types the file form holds and this engine does not run. */
export function workflowStepTypesNotRun(): string[] {
  const executed: readonly string[] = WORKFLOW_EXECUTED_STEP_TYPES;
  return WORKFLOW_STEP_TYPES.filter((type) => !executed.includes(type));
}

function content(packages: readonly WorkflowRunnerPackage[]): string {
  const examples = EXAMPLES.map(
    ({ title, yaml }) => `### ${title}\n\n\`\`\`yaml\n${yaml}\n\`\`\``
  ).join("\n\n");
  return `# Writing the definition of a Workflow

Read this before you change the definition of a Workflow. It says what a definition holds, what
the engine of this release runs, and how to save a change safely.

When the person asks to publish, use assets.publish if it is available: it offers the person the publish confirmation and cannot publish without their click. Do not say you cannot publish when that tool is offered. Speak in the person's language: say schedule and draft, not Cron or Draft Revision numbers.

For a schedule, read platform.context instance.timeZone. Write the wall-clock hour the person asks for together with timeZone on the schedule trigger. Use an explicit IANA zone the person names (German time means Europe/Berlin), otherwise the instance zone. When instance.timeZoneDefaulted is true and no other zone was requested, explain that the default is UTC. Never subtract a UTC offset from the hour yourself.

Whether the work is a Workflow at all, or an App or a View: \`references/apps/app-or-workflow.md\`
in \`platform-docs\`.

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

## Preparing data scope

Follow the build rules for data scope in the platform docs: \`references/configure/release-config.md\` in \`platform-docs\`.

- Write the Mandant key on every copied row and keep it in aggregates and run history.
- Design per-Mandant work as child runs keyed by the Mandant and the period, such as \`key: [{ value: "2026-09" }, { ref: { step: <loop id>, path: <the Mandant's number> } }]\`. Starting the parent again for that period then runs only the children that did not end done. Do not replace them with an unkeyed cross-Mandant run.
- Keep the rules revision of a check in one authored value. Give the child a required input
  \`${REVISION}: { type: string }\` and let its script read the revision from that input, never
  from a constant of its own. In the parent, write the value once, as the literal input of a
  \`code\` step whose script, \`steps/rules.py\`, returns its input (\`${ECHO}\`), and reference
  that step's output in the child's input and in its key alike:

  \`\`\`yaml
${RULES_REVISION_STEPS.replace(/^/gmu, "  ")}
  \`\`\`

  When a rule changes, change the child's script and that one literal. No reference reaches into
  another definition, so the parent cannot read the child's revision. A check warns with
  \`child_key_without_rules_revision\` where a keyed step passes \`${REVISION}\` to a child that
  declares it and the key holds neither that source nor the child's \`const\`. It reads the
  mappings, the keys and the child's inputs, never a script: a revision kept only in a script is
  not checked, and a key without the revision lets the children that are done answer with what
  they found under the old rules.
- Say who a Workflow is for when it serves only part of the firm. Everyone in that audience must be allowed to see every Mandant the shared source credential can read.

## What a manifest is

\`manifest\` is the file \`workflow.yaml\` as an object. It holds these fields and no other:

- \`id\`: the id of the Workflow: lowercase letters, digits, \`_\` and \`-\`. It is the \`name\` of
  the config. Never change it.
- \`name\`: what a person calls the Workflow. \`description\`: one or two plain sentences, optional.
- \`runAs\`: optional. Leave it out of a new Workflow. The first publish then creates the
  Workflow's own account, which may use only what its steps call, and the publish question says
  so in one line. Set it only when the person asks the Workflow to run as an existing shared
  account: call platform.context and use a name from workflowPrincipals, never an invented
  name. Never use an integration, CLI or release account. Keep a \`runAs\` a definition already
  has unless the person asks to change it: a publish checks whether its publisher may let a
  Workflow act as that account.
- \`kind\`: \`process\` unless set. Use \`data\` for a Workflow that fills or processes a Knowledge Base or Data Store. Publishing Knowledge Base \`ingest\`, \`withdraw\`, \`put_processed\` or Data Store \`records.propose\` from a process Workflow is refused with \`process_workflow_write_operation\`. A copied data template keeps \`kind: data\`.
- \`labels\`: optional mapping of names to text or numbers, as literals such as
  \`client: { value: acme }\` or references such as \`client: { ref: { step: start, path: input.client } }\`.
  A reference must name the trigger. Labels are evaluated once at the start and kept by every successor.
- \`onFailure\`: optional. \`notify\`, the default, is the only value this engine runs: the failed
  descendants of one root produce one notice to the publisher of the root's revision when the
  root ends. \`onFailure: workflow.<id>\` is reserved for EW-13 and refused.
- \`packages\`: optional list of installed Python distribution names required by the code steps,
  for example \`packages: [pypdf]\`. Publish refuses any name outside the runner allow-list below.
- \`inputs\`: the JSON Schema of the input a run is started with. An object schema.
- \`outputs\`: the JSON Schema of the result of a run. An object schema.
- \`steps\`: the steps in the order they run, at most ${WORKFLOW_DEFINITION_MAX_STEPS} with the steps of loops counted.
  The first is the \`trigger\`, the last the \`output\`.
- \`limits\`: optional, the bounds of each run where the defaults do not fit. Set only what the
  person needs, under the ceilings of the instance, which a publish names when it refuses:
  - \`duration\`: how long a run may work, such as \`30h\` or \`7d\`; ${workflowDurationText(WORKFLOW_RUN_MAX_DURATION_MS)} when left out.
    Time a run waits, for work that ends later or for a child, does not count.
  - \`stepRuns\`: how many step runs a run may create, ${WORKFLOW_RUN_MAX_STEP_RUNS} when left out.
  - \`loopItems\`: how many items one loop's list may hold, ${WORKFLOW_LOOP_MAX_ITEMS} when left out.
  - \`concurrency\`: how many steps the Workflow's runs and their children run at once, all
    together; every step slot of the instance when left out. A loop's \`concurrency\` stays
    the bound of that loop.
  - \`datasetBytes\`: not above its default yet. \`pagedStepMinutes\` may be raised within the operator ceiling.

  A publish that raises a limit names the raise in its question. Say so to the person.

Every step has an \`id\` (lowercase letters, digits, \`_\` and \`-\`, unique in the whole
definition), a \`name\` a person reads on the run's page, an optional \`description\` and a \`type\`.
A step holds the fields of its type and no other: a field the type does not have is refused.

There is no wiring between steps. They run from top to bottom, and a loop holds its own steps.

## The step types this engine runs

${stepReference()}

${stepFilesReference()}

## Runner package allow-list

${packages.length === 0 ? "No runner package manifest is available: the allow-list is empty, so publish refuses every declared package." : packages.map(({ name, version }) => `- \`${name}\` (${version})`).join("\n")}

Use distribution names here: \`python-docx\` imports as \`docx\`, \`Pillow\` as \`PIL\`.
Packages are installed and pinned when the release image is built. Nothing is installed at
publish or run time, and the container has no network. Imports are not restricted to declared
packages. Adding a package requires a runner image release. There is no package-count cap.

## Mappings and references

The \`input\` of a step is a mapping: one entry per field, and each entry is exactly one of

- \`value: <any JSON>\`: a literal, and
- \`ref: { step: <id of an earlier step>, path: <dotted path into its output> }\`: a field of
  what an earlier step answered, and
- \`text: [<part>, ...]\` for a field whose schema is a string: literal strings and
  \`{ ref: { step, path } }\` parts, joined in order, such as
  \`subject: { text: ["Prüfergebnis ", { ref: { step: start, path: input.month } }] }\`. A
  referenced part is a text, a number or a yes-or-no value; \`null\` joins as empty text. In a
  field whose schema has \`format: markdown\`, such as the body of a mail, a referenced list of
  strings joins as a bulleted list and a list of flat records as a table of at most 100 rows
  and 8 columns, every referenced value is escaped, and a dataset is refused.

A mapping holds no expression, no template and no arithmetic; joining text only joins. What
needs computing is done by the operation a step calls or by a code step.

- A reference names a step that ran before the step it stands in. A step outside a loop cannot
  name a step inside it.
- The path is dotted, such as \`rows\` or \`customer.address.city\`. An empty path is the whole
  output.
- The run's input is read from the trigger: \`{ step: <trigger id>, path: input.<field> }\`.
- Inside a loop, the id of the loop is the current item: \`{ step: <loop id>, path: <field> }\`.
  After the loop the same id is its counts: \`total\`, \`done\`, \`failed\`.
- What an operation answers decides the path into its output. Where you do not know the shape,
  say so to the person instead of guessing a path: a wrong path fails the run, not the save.

The input and the output of one step may each be at most ${WORKFLOW_STEP_DATA_MAX_BYTES} bytes as JSON. Dataset references count toward this bound; their rows do not.

## Datasets

For bulk object rows, set \`dataset: { at: rows }\` on an operation step when its answer has a list at \`rows\`. The step replaces that list with \`{ $dataset, rowCount, bytes }\`. Later mappings reference the same path. Never invent a dataset id or put its rows into a step record.

Declare a dataset field as \`{ type: dataset, row: <JSON Schema of one object row> }\`. A manifest may declare reusable row schemas under \`types\` and use \`row: { $ref: "#/types/<name>" }\`. A producer must guarantee the fields and types the consumer requires; extra fields fit. Each row is checked as it is written. A schema error names the line and field, never the value.

A loop may read a dataset as \`items\`, under the loop's item limit. With \`onItemFailure: continue\`, it returns counts and a \`failures\` dataset of index, optional label and error code. A loop does not return its item results inline. Keep bulk processing in operations rather than making a step run per data row.

Workflow inputs and outputs, including child inputs and results, may contain dataset references. A run reads only datasets it wrote, received as input or got from a child. A person passing a dataset into a root run needs \`workflow.read_run_data\` on its source Workflow. Dataset rows never reach an \`agent\` step in this release (EW-14b).

A \`code\` step reads and writes datasets as files; its container still has no network. A dataset in its \`inputSchema\` reaches the script as \`{ "path": "/work/in/<field>.jsonl", "rowCount": <n> }\`: a read-only file of JSON Lines, one row per line. Read it line by line and never load it whole. To write a dataset, declare it in \`outputSchema\` as \`{ type: dataset, row: ... }\`, write one JSON object per line to a file directly in \`/work/out/\` and name that file in the result as \`{ "path": "/work/out/findings.jsonl" }\`. Write findings that way, not as a list in the result, which stays small:

\`\`\`python
import json
data = json.load(open("input.json"))
with open(data["postings"]["path"]) as rows, open("/work/out/findings.jsonl", "w") as out:
    for line in rows:
        posting = json.loads(line)
        if posting["amount"] < 0:
            out.write(json.dumps({"client_id": posting["client_id"], "rule": "negative"}) + "\\n")
json.dump({"findings": {"path": "/work/out/findings.jsonl"}}, open("output.json", "w"))
\`\`\`

After the script ended, every line of a named file is checked against the row schema while it is stored. A line that is no JSON object of that schema fails the step with \`dataset_row_invalid\` and its line number, never its content. A path that is not one file directly in \`/work/out/\` fails with \`${WORKFLOW_CODE_ERRORS.datasetPathInvalid}\`; a link, a pipe, a folder or a missing file with \`${WORKFLOW_CODE_ERRORS.datasetFileInvalid}\`. The input files and what a script writes to \`/work/out/\` are bounded together by the release setting \`workflows.codeSteps.diskBytes\`, 2 GiB unless set; past it the step fails with \`${WORKFLOW_CODE_ERRORS.diskLimit}\`. A dataset the input names twice is one file.

Successful runs release intermediates. Failed runs retain datasets for their resume window; root output datasets default to seven days, or \`retention: { datasets: <days> }\`, bounded by step-data retention. Test roots keep no output datasets. Operator ceilings live under \`workflows.datasets\`; they are settings, not fixed customer limits. A producing step that reaches one fails with \`dataset_limit\` and its name. Deleted or unavailable parts answer \`dataset_expired\`.

A reading Connection operation may declare paging by page, offset, cursor or next_link. Use \`paginate: true\` with \`dataset: { at: items }\` to take its paging settings, or override fields with \`paginate: { size: 100 }\`. Other output fields come from the first page. One paged step keeps one Operation Run with counts only. A lost worker resumes at the last complete page. Rows, bytes, pageBytes and pages are operator ceilings under \`workflows.datasets\`. The minute ceiling is \`workflows.limits.pagedStepMinutes\`; the Workflow may set \`limits.pagedStepMinutes\` under it. A limit fails the step, so no consumer gets a partial dataset. A changing source can repeat or skip rows between pages; load with a key removes repeats.

A Data Store query with \`dataset: { at: rows }\` reads its full cursor into a dataset instead of the ordinary inline row cap. To put those rows into a table, call \`data_store.<id>.load\` with \`{ table, dataset }\`. Optional \`columns\` maps row fields to columns; \`key\` names a unique constraint, \`onConflict: skip | update\` needs that key, and \`replace: { by: [columns] }\` replaces the matching groups (each column of \`by\` is part of \`key\`). When a rerun may find no rows, name the group the step owns with \`replace: { by: [client_id, month, rules_revision], values: { client_id, month, rules_revision } }\`: \`values\` gives exactly the columns of \`by\` as non-null scalars, taken from the scope the step was asked for, not from its rows. An empty dataset then clears that group only, and a row outside it refuses the whole load. A mapping holds no template, so build the \`replace\` object in a \`code\` step from that scope and pass it with one reference. A retry of the same step returns the first load result. Loads need \`data_store.insert\`, plus \`data_store.execute\` for update or replace. The operator controls \`dataStores.load\` and \`dataStores.queryTimeoutMs\`; if a dataset exceeds one atomic load, produce smaller datasets upstream or ask the operator to raise its ceiling.

A dataset returned by the run can be downloaded as JSON Lines or CSV through \`workflows.download_dataset\`. Rows need \`workflow.read_run_data\`, or the caller must have started that run. Collection is still deferred; do not offer it.

## What this engine does not run yet

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
operation that does the comparison in the outside system.

## Examples

${examples}
`;
}

/** The skill as the platform ships it, offered to a conversation about a Workflow. */
export function createWorkflowAuthoringSkill(
  packages: readonly WorkflowRunnerPackage[]
): ShippedSkill {
  return {
    name: WORKFLOW_AUTHORING_SKILL_NAME,
    title: "Writing a Workflow",
    description:
      "How to read, change, check and save the definition of a Workflow: what a manifest holds, the step types this engine runs, the scripts of its code steps, references between steps and what is not run yet. Read it before you change a Workflow.",
    content: content(packages),
    icon: "workflow"
  };
}

/** Without an image manifest, authoring fails closed just as publishing does. */
export const workflowAuthoringSkill = createWorkflowAuthoringSkill([]);
