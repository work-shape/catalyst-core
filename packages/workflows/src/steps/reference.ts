import type { WORKFLOW_EXECUTED_STEP_TYPES } from "../definition";
import { agentReference } from "./agent.reference";
import { codeReference } from "./code.reference";
import { loopReference } from "./loop.reference";
import type { StepReference } from "./module";
import { notifyReference } from "./notify.reference";
import { operationReference } from "./operation.reference";
import { outputReference } from "./output.reference";
import { triggerReference } from "./trigger.reference";
import { workflowReference } from "./workflow.reference";

type ExecutedStepType = (typeof WORKFLOW_EXECUTED_STEP_TYPES)[number];

/**
 * What the authoring skill says of each step type this engine runs: one line per type. The type
 * makes every executed step type, and every field of it, a required key, so a release that runs
 * another step, or gives one another field, does not build until the skill says what it is.
 */
export const STEP_REFERENCE: { [Type in ExecutedStepType]: StepReference<Type> } = {
  trigger: triggerReference,
  operation: operationReference,
  workflow: workflowReference,
  loop: loopReference,
  agent: agentReference,
  code: codeReference,
  notify: notifyReference,
  output: outputReference
};
