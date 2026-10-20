import {
  WORKFLOW_DEFINITION_MAX_STEPS,
  WORKFLOW_LOOP_MAX_ITEMS,
  WORKFLOW_RUN_MAX_DURATION_MS,
  WORKFLOW_RUN_MAX_STEP_RUNS
} from "../../limits";
import { workflowDurationText } from "../../run-limits";

/** The fields of a manifest and what every step carries. */
export const manifestSection = `## What a manifest is

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

There is no wiring between steps. They run from top to bottom, and a loop holds its own steps.`;
