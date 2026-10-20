import type { StepReference } from "./module";

/** What the authoring skill says of a `agent` step. */
export const agentReference = {
  does: "Runs an AI step as the Workflow principal, with the Workflow tools and the instance default model. It validates JSON output and allows one repair turn without tools. Confirmation fails with confirmation_unattended; approval pauses the run.",
  fields: {
    instructions: "What the agent should do with its input and return as JSON.",
    input: "A mapping onto inputSchema; datasets are not supported in agent inputs yet.",
    inputSchema: "The JSON Schema of its mapped input.",
    outputSchema:
      "An object, array, string, number or boolean schema with named properties, required fields and enums; no references or recursion."
  }
} satisfies StepReference<"agent">;
