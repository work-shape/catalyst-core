import type {
  PlatformStores,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepRun
} from "@work-shape/catalyst-core";
import { workflowDatasetReferenceSchema } from "@work-shape/catalyst-core";
import { workflowLoopTailSteps, type WorkflowStepIndex } from "./definition";
import { resolveReference } from "./references";
import { WorkflowStepFailure } from "./step-failure";

/** An upper bound for a whole item, including every nested iteration, not just its block. */
export async function loopItemReservation(
  tx: PlatformStores,
  run: WorkflowRun,
  index: WorkflowStepIndex,
  loopRun: WorkflowStepRun,
  steps: readonly WorkflowStep[]
): Promise<{ item: number; tail: number }> {
  async function cost(
    steps: readonly WorkflowStep[],
    nested: ReadonlySet<string>
  ): Promise<number> {
    let total = 0;
    for (const step of steps) {
      total++;
      if (step.type !== "loop") continue;
      // A reference to the current item, or an output not produced yet, is not known at
      // admission. Reserve the loop's ceiling and admit such an oversized item on its own.
      let items = step.continueAsNew ? Infinity : run.limits.loopItems;
      if (!nested.has(step.items.step)) {
        try {
          const value = await resolveReference(
            {
              store: tx.workflowRuns,
              index,
              run,
              stepRun: {
                ...loopRun,
                stepId: step.id,
                containerStepRunId: loopRun.id,
                iteration: { index: 0 }
              }
            },
            step.items
          );
          const dataset = workflowDatasetReferenceSchema.safeParse(value);
          if (Array.isArray(value)) items = value.length;
          else if (dataset.success) items = Math.ceil(dataset.data.rowCount / (step.batch ?? 1));
        } catch (error) {
          if (!(error instanceof WorkflowStepFailure)) throw error;
        }
      }
      total += items * (await cost(step.steps, new Set([...nested, step.id])));
      if (total > run.limits.stepRuns) return Infinity;
    }
    return total;
  }
  return {
    item: await cost(steps, new Set([loopRun.stepId])),
    tail: workflowLoopTailSteps(index, loopRun.stepId)
  };
}
