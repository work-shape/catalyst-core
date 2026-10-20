import { WORKFLOW_EXECUTED_STEP_TYPES } from "../../definition";
import { STEP_REFERENCE } from "../../steps/reference";

function stepReference(): string {
  return WORKFLOW_EXECUTED_STEP_TYPES.map((type) => {
    const { does, fields } = STEP_REFERENCE[type];
    const lines = Object.entries(fields).map(([field, says]) => `- \`${field}\`: ${says}`);
    return [`### \`type: ${type}\``, does, ...lines].join("\n");
  }).join("\n\n");
}

/** Each step type this engine runs, from `steps/<type>.reference.ts`. */
export const stepTypesSection = `## The step types this engine runs\n\n${stepReference()}`;
