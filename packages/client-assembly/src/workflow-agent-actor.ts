import { workflowRunActor } from "@work-shape/catalyst-workflows";
import type { AgentRun, PlatformStores } from "@work-shape/catalyst-core";

/** Uses the acting principal the Workflow run resolved, including its own account (LIVE-1). */
export async function workflowAgentActor(stores: PlatformStores, run: AgentRun) {
  if (!run.workflowStepRunId) return undefined;
  const clientInstanceId = run.clientInstanceId;
  const step = await stores.workflowRuns.getStepRun({
    clientInstanceId,
    id: run.workflowStepRunId
  });
  const workflow =
    step && (await stores.workflowRuns.readRun({ clientInstanceId, id: step.runId }));
  const actor = workflow && (await workflowRunActor(stores.apiAccess, workflow));
  return actor && actor.id === run.principalId ? actor : undefined;
}
