import { workflowRunActor, testRunCall } from "@work-shape/catalyst-workflows";
import type { AgentRun, PlatformStores } from "@work-shape/catalyst-core";

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
