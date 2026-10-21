import { AGENT_OUTPUT_SCHEMA_KEYS } from "../agent-schema";
import type { StepReference } from "./module";

const keys = AGENT_OUTPUT_SCHEMA_KEYS.map((key) => `\`${key}\``).join(", ");

/** What the authoring skill says of a `agent` step. */
export const agentReference = {
  does: "Runs an AI step as the Workflow principal, with the Workflow tools and the instance default model. It validates JSON output and allows one repair turn without tools. Confirmation fails with confirmation_unattended; approval pauses the run.",
  fields: {
    instructions: "What the agent should do with its input and return as JSON.",
    input: "A mapping onto inputSchema; datasets are not supported in agent inputs yet.",
    inputSchema: "The JSON Schema of its mapped input.",
    outputSchema: `An object, array, string, number or boolean schema with named properties, required fields and enums; no references or recursion. Use only the keys ${keys} at every level: \`minItems\`, \`maxItems\`, \`minLength\`, \`format\`, \`pattern\`, \`anyOf\`, \`oneOf\`, \`const\`, \`default\` and \`$ref\` are refused, so say a bound or a format in \`description\` and check it in a later step. When the Workflow's result is shown in an App, return each thing the App shows as its own field (priorities, decisions, changes, sources and the like, with lists as \`type: array\`), not one text: the App lays out fields, it cannot take prose apart.`
  }
} satisfies StepReference<"agent">;
