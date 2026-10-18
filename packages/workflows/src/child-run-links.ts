import {
  AppError,
  isWorkflowRunEnded,
  type WorkflowRun,
  type WorkflowRunId,
  type WorkflowRunsStore
} from "@work-shape/catalyst-core";

/**
 * Behind the instance's keyed-link lock and the caller and key holder's row locks.
 * Published graphs do not describe pinned revisions or draft tests. Follow only open
 * workflow steps: a finished step no longer waits. The visited set also terminates on a
 * pre-existing cycle.
 */
export async function assertRunLinkIsAcyclic(
  runs: WorkflowRunsStore,
  caller: WorkflowRun,
  holder: WorkflowRun
): Promise<void> {
  const { clientInstanceId } = caller;
  const refuse = () => {
    throw new AppError(
      "CONFLICT",
      `The key for Workflow '${holder.workflow}' is held by a run in its own call chain`,
      { reason: "run_key_cycle" }
    );
  };
  // Ancestors are forbidden even when resumed children outlive a completed parent.
  const ancestors = new Set<WorkflowRunId>();
  let ancestor: WorkflowRun | undefined = caller;
  while (ancestor && !ancestors.has(ancestor.id)) {
    if (ancestor.id === holder.id) refuse();
    ancestors.add(ancestor.id);
    ancestor = ancestor.parentRunId
      ? await runs.readRun({ clientInstanceId, id: ancestor.parentRunId })
      : undefined;
  }

  const pending = [holder.id];
  const visited = new Set<WorkflowRunId>();
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === caller.id) refuse();
    if (visited.has(id)) continue;
    visited.add(id);
    const run = await runs.readRun({ clientInstanceId, id });
    if (!run || isWorkflowRunEnded(run.status)) continue;
    for (const step of await runs.listOpenStepRuns({ clientInstanceId, id })) {
      if (step.stepType !== "workflow") continue;
      const target =
        step.linkedRunId ?? (await runs.findChildRun({ clientInstanceId, id: step.id }))?.id;
      if (target) pending.push(target);
    }
  }
}
