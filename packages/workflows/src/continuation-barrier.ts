import type { PlatformStores, WorkflowRun, WorkflowStepRun } from "@work-shape/catalyst-core";
import type { WorkflowStepIndex } from "./definition";

/** Concurrent loop items drain to their common boundary; branch sequences can stop between steps. */
export async function drainsContinuation(
  tx: PlatformStores,
  run: WorkflowRun,
  index: WorkflowStepIndex,
  stepRun: WorkflowStepRun
): Promise<boolean> {
  let container = stepRun.containerStepRunId;
  while (container) {
    const parent = await tx.workflowRuns.getStepRun({
      clientInstanceId: run.clientInstanceId,
      id: container
    });
    if (!parent) break;
    const step = index.get(parent.stepId)?.step;
    if (step?.type === "loop" && (step.concurrency ?? 1) > 1) return true;
    container = parent.containerStepRunId;
  }
  return false;
}

export async function continuationIsBusy(
  tx: PlatformStores,
  run: WorkflowRun,
  index: WorkflowStepIndex
) {
  const open = await tx.workflowRuns.listOpenStepRuns({
    clientInstanceId: run.clientInstanceId,
    id: run.id
  });
  for (const step of open) {
    if (step.status === "running") return true;
    if (step.status === "waiting" && !["loop", "parallel", "condition"].includes(step.stepType))
      return true;
    if (step.status === "queued" && (await drainsContinuation(tx, run, index, step))) return true;
  }
  return false;
}
