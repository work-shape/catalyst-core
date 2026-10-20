import { indexWorkflowSteps, testRunCall, workflowRunActor } from "@work-shape/catalyst-workflows";
import {
  AppError,
  type AgentRun,
  type OperationRegistry,
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

/** Where a draft test's agent step resolves the rights a Workflow-owned account is bounded by. */
type OperationResolver = Pick<OperationRegistry, "resolveMany">;

/** Revalidates the pinned principal and, in draft tests, the tester on every claim/resume. */
export async function workflowAgentCall(
  stores: PlatformStores,
  registry: OperationResolver,
  run: AgentRun
) {
  if (!run.workflowStepRunId) return undefined;
  const clientInstanceId = run.clientInstanceId;
  const step = await stores.workflowRuns.getStepRun({
    clientInstanceId,
    id: run.workflowStepRunId
  });
  const workflow =
    step && (await stores.workflowRuns.readRun({ clientInstanceId, id: step.runId }));
  if (!workflow || !step) return undefined;
  if (workflow.mode === "test") {
    // A draft test runs as its tester, bounded by the principal its run names; a Workflow-owned
    // account is bounded by the rights its definition needs, as its steps are (ADR-0031).
    const definition = await stores.workflowRuns.readRunDefinition({
      clientInstanceId,
      id: workflow.id
    });
    if (!definition) return undefined;
    const call = await testRunCall(stores, workflow, step, definition, registry);
    return call.actor.id === run.ownerUserId ? call : undefined;
  }
  const principal = await workflowRunActor(stores.apiAccess, workflow);
  return principal && principal.id === run.principalId ? { actor: principal } : undefined;
}
export async function workflowAgentActor(
  stores: PlatformStores,
  registry: OperationResolver,
  run: AgentRun
) {
  return (await workflowAgentCall(stores, registry, run))?.actor;
}
