import type { WorkflowManifest, WorkflowStepRunView } from "@vivd-catalyst/core";
import { indexWorkflowSteps } from "./definition";

/**
 * The step runs of a run with the `bodyCounts` of each loop complete. A step of a loop that
 * no item has reached yet has no step run to count; the run's definition names it, so its
 * node reads none of the loop's items as done.
 */
export function withEveryBodyStep(
  stepRuns: WorkflowStepRunView[],
  definition: WorkflowManifest
): WorkflowStepRunView[] {
  const index = indexWorkflowSteps(definition);
  return stepRuns.map((stepRun) => {
    const loop = index.get(stepRun.stepId)?.step;
    if (!stepRun.bodyCounts || loop?.type !== "loop") return stepRun;
    const total = stepRun.loop?.total ?? 0;
    const reached = stepRun.bodyCounts;
    return {
      ...stepRun,
      bodyCounts: Object.fromEntries(
        loop.steps.map((inner) => [
          inner.id,
          reached[inner.id] ?? { total, done: 0, failed: 0, running: 0 }
        ])
      )
    };
  });
}
