import {
  AppError,
  type PlatformStores,
  type AgentRun,
  type StartAgentRunInput
} from "@work-shape/catalyst-core";

/** Reconstructs the agent from the run's pinned revision, including after an approval. */
export async function readWorkflowAgentInput(
  stores: PlatformStores,
  run: AgentRun
): Promise<StartAgentRunInput["workflowAgent"]> {
  if (!run.workflowStepRunId) return undefined;
  const clientInstanceId = run.clientInstanceId;
  const stepRun = await stores.workflowRuns.getStepRun({
    clientInstanceId,
    id: run.workflowStepRunId
  });
  const definition =
    stepRun &&
    (await stores.workflowRuns.readRunDefinition({ clientInstanceId, id: stepRun.runId }));
  const find = (
    steps: readonly import("@work-shape/catalyst-core").WorkflowStep[]
  ): import("@work-shape/catalyst-core").WorkflowStep | undefined => {
    for (const step of steps) {
      if (step.id === stepRun?.stepId) return step;
      if (step.type === "loop") {
        const found = find(step.steps);
        if (found) return found;
      }
    }
    return undefined;
  };
  const step = definition && find(definition.steps);
  if (!stepRun || !definition || step?.type !== "agent")
    throw new AppError("NOT_FOUND", "Workflow agent definition is unavailable");
  return {
    workflowRunId: stepRun.runId,
    instructions: step.instructions,
    toolNames: definition.tools ?? [],
    outputSchema: step.outputSchema
  };
}
