import { indexWorkflowSteps, testRunCall, workflowRunActor } from "@work-shape/catalyst-workflows";
import {
  AppError,
  type AgentRun,
  type PlatformStores,
  type StartAgentRunInput,
  type WorkflowStep,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";

/**
 * The step run, the pinned definition of its Workflow Run and the agent step of a Workflow
 * agent step's Agent Run (CR-2). Its agent is the step, never an agent asset of its name.
 */
export async function workflowAgentStep(
  stores: PlatformStores,
  run: AgentRun
): Promise<
  | {
      stepRun: WorkflowStepRun;
      step: Extract<WorkflowStep, { type: "agent" }>;
      tools: readonly string[];
    }
  | undefined
> {
  if (!run.workflowStepRunId) return undefined;
  const clientInstanceId = run.clientInstanceId;
  const stepRun = await stores.workflowRuns.getStepRun({
    clientInstanceId,
    id: run.workflowStepRunId
  });
  const definition =
    stepRun &&
    (await stores.workflowRuns.readRunDefinition({ clientInstanceId, id: stepRun.runId }));
  const step = definition && indexWorkflowSteps(definition).get(stepRun.stepId)?.step;
  return stepRun && definition && step?.type === "agent"
    ? { stepRun, step, tools: definition.tools ?? [] }
    : undefined;
}

/** What the run's worker builds the agent from, after a pause too: the pinned step. */
export async function workflowAgentInput(
  stores: PlatformStores,
  run: AgentRun
): Promise<NonNullable<StartAgentRunInput["workflowAgent"]>> {
  const found = await workflowAgentStep(stores, run);
  if (!found) throw new AppError("NOT_FOUND", "Workflow agent definition is unavailable");
  return {
    workflowRunId: found.stepRun.runId,
    instructions: found.step.instructions,
    toolNames: found.tools,
    outputSchema: found.step.outputSchema
  };
}

/** Revalidates the pinned principal and, in draft tests, the tester on every claim/resume. */
export async function workflowAgentCall(stores: PlatformStores, run: AgentRun) {
  if (!run.workflowStepRunId) return undefined;
  const clientInstanceId = run.clientInstanceId;
  const step = await stores.workflowRuns.getStepRun({
    clientInstanceId,
    id: run.workflowStepRunId
  });
  const workflow =
    step && (await stores.workflowRuns.readRun({ clientInstanceId, id: step.runId }));
  const principal = workflow && (await workflowRunActor(stores.apiAccess, workflow));
  if (
    !workflow ||
    !step ||
    !principal ||
    (workflow.mode !== "test" && principal.id !== run.principalId)
  )
    return undefined;
  if (workflow.mode === "test") {
    const call = await testRunCall(stores, workflow, step);
    return call.actor.id === run.ownerUserId ? call : undefined;
  }
  return { actor: principal };
}
export async function workflowAgentActor(stores: PlatformStores, run: AgentRun) {
  return (await workflowAgentCall(stores, run))?.actor;
}
