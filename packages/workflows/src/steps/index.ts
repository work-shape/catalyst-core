import type { WorkflowStep } from "@work-shape/catalyst-core";
import { z } from "zod";
import { agentStep } from "./agent";
import { codeStep } from "./code";
import { conditionStep } from "./condition";
import type { StepModule, StepOf, WorkflowFileStepType } from "./module";
import { loopStep } from "./loop";
import { notifyStep } from "./notify";
import { operationStep } from "./operation";
import { outputStep } from "./output";
import { parallelStep } from "./parallel";
import { triggerStep } from "./trigger";
import { workflowStep } from "./workflow";
import type { WorkflowDefinitionIssue } from "../definition-issue";

/** Every step type of the file form, by its type: one line per type. */
const STEP_MODULES = {
  trigger: triggerStep,
  operation: operationStep,
  workflow: workflowStep,
  loop: loopStep,
  code: codeStep,
  output: outputStep,
  agent: agentStep,
  notify: notifyStep,
  condition: conditionStep,
  parallel: parallelStep
} satisfies { [Type in WorkflowFileStepType]: StepModule<Type> };

const modules: { [Type in WorkflowFileStepType]: StepModule<Type> } = STEP_MODULES;

// Every step the file form holds, the reserved blocks among them, so that a file written for
// a later engine is read here and refused by name instead of as a file nobody understands.
export const workflowStepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.discriminatedUnion("type", [
    STEP_MODULES.trigger.schema(),
    STEP_MODULES.operation.schema(),
    STEP_MODULES.workflow.schema(),
    STEP_MODULES.loop.schema(workflowStepSchema),
    STEP_MODULES.code.schema(),
    STEP_MODULES.output.schema(),
    STEP_MODULES.agent.schema(),
    STEP_MODULES.notify.schema(),
    STEP_MODULES.condition.schema(workflowStepSchema),
    STEP_MODULES.parallel.schema(workflowStepSchema)
  ])
);

function issuesOf<Type extends WorkflowFileStepType>(
  type: Type,
  step: StepOf<Type>,
  check: "unsupported" | "structural",
  where: string
): WorkflowDefinitionIssue[] {
  return modules[type][check]?.(step, where) ?? [];
}

/** What the step holds that this engine reads and does not run, at its path `at`. */
export function stepUnsupportedIssues(step: WorkflowStep, at: string): WorkflowDefinitionIssue[] {
  return issuesOf(step.type, step, "unsupported", at);
}

/** What must hold of the step itself, by its id. */
export function stepStructuralIssues(step: WorkflowStep, id: string): WorkflowDefinitionIssue[] {
  return issuesOf(step.type, step, "structural", id);
}
