import { AGENT_OUTPUT_SCHEMA_KEYS } from "../agent-schema";
import type { StepReference } from "./module";

const keys = AGENT_OUTPUT_SCHEMA_KEYS.map((key) => `\`${key}\``).join(", ");

/** What the authoring skill says of a `agent` step. */
export const agentReference = {
  does: "Runs an AI step as the Workflow principal, with the Workflow tools, on the binding `model` names or the instance default model. It validates JSON output and allows one repair turn without tools. Confirmation fails with confirmation_unattended; approval pauses the run.",
  fields: {
    instructions: "What the agent should do with its input and return as JSON.",
    input:
      "A mapping onto inputSchema. A dataset is refused unless `workspace: true`, where the agent reads it as a file.",
    model:
      "Optional. The id of a model binding agents may select on the instance, such as a small model for sorting or extraction; leave it out for the instance default. Any other id is refused at save and publish with model_not_available.",
    workspace:
      "Optional, `true` or left out. The agent then works like a developer in a sandbox without network: its input is under /workspace/in/ (input.json, each dataset as JSON Lines, each long text and run file as a file), it has workspace.exec (Bash, Python), read_file, write_file, edit_file and list_files to inspect, parse, check and try again, and a dataset field of outputSchema (`type: dataset` with `row`) is answered with `{ path }` of a JSON Lines file it wrote. Use it where a fixed `code` step cannot know the shape of what comes in, such as odd tables in documents.",
    inputSchema: "The JSON Schema of its mapped input.",
    outputSchema: `An object, array, string, number or boolean schema with named properties, required fields and enums; no references or recursion. Use only the keys ${keys} at every level: \`minItems\`, \`maxItems\`, \`minLength\`, \`format\`, \`pattern\`, \`anyOf\`, \`oneOf\`, \`const\`, \`default\` and \`$ref\` are refused, so say a bound or a format in \`description\` and check it in a later step. When the Workflow's result is shown in an App, return each thing the App shows as its own field (priorities, decisions, changes, sources and the like, with lists as \`type: array\`), not one text: the App lays out fields, it cannot take prose apart.`
  }
} satisfies StepReference<"agent">;
