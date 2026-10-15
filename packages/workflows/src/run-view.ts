import {
  WORKFLOW_LOOP_MAX_CONCURRENCY,
  type WorkflowManifest,
  type WorkflowStep,
  type WorkflowStepRunView
} from "@work-shape/catalyst-core";
import { indexWorkflowSteps } from "./definition";
import { WORKFLOW_STEP_JOB_SLOTS } from "./limits";

/** How many items of a loop are going at once at most: its `concurrency`, within the bounds. */
export function loopConcurrencyOf(loop: Extract<WorkflowStep, { type: "loop" }>): number {
  return Math.min(Math.max(1, loop.concurrency ?? 1), WORKFLOW_LOOP_MAX_CONCURRENCY);
}

/**
 * The step runs of a run as a read shows them. The step run of a loop says how many of its
 * items run at once: what the loop asks for, and what a process runs of that with its step
 * slots. Its `bodyCounts` are complete: a step of a loop that no item has reached yet has no
 * step run to count; the run's definition names it, so its node reads none of the loop's
 * items as done.
 */
export function withEveryBodyStep(
  stepRuns: WorkflowStepRunView[],
  definition: WorkflowManifest
): WorkflowStepRunView[] {
  const index = indexWorkflowSteps(definition);
  return stepRuns.map((stepRun) => {
    const loop = index.get(stepRun.stepId)?.step;
    if (loop?.type !== "loop" || stepRun.stepType !== "loop") return stepRun;
    const asked = loopConcurrencyOf(loop);
    const shown: WorkflowStepRunView = {
      ...stepRun,
      concurrency: { asked, ranWith: Math.min(asked, WORKFLOW_STEP_JOB_SLOTS) }
    };
    if (!stepRun.bodyCounts) return shown;
    const total = stepRun.loop?.total ?? 0;
    const reached = stepRun.bodyCounts;
    return {
      ...shown,
      bodyCounts: Object.fromEntries(
        loop.steps.map((inner) => [
          inner.id,
          reached[inner.id] ?? { total, done: 0, failed: 0, running: 0 }
        ])
      )
    };
  });
}
