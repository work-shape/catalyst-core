import { loopItemReservation } from "./loop-reservation";
import { loopFailureRowSchema } from "./dataset-values";
import { WorkflowStepFailure } from "./step-failure";
import type {
  ClientInstanceId,
  PlatformStores,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepRun,
  WorkflowStepRunRef,
  WorkflowStepRunPlacement,
  WorkflowLoopOutput
} from "@work-shape/catalyst-core";
import type { WorkflowStepIndex } from "./definition";
import type { WorkflowDatasets } from "./datasets";
import { loopConcurrencyOf } from "./run-view";
import { itemLabelOf } from "./references";
type StepPlace = WorkflowStepRunPlacement & { key: string };
export function createLoopProgress(options: {
  clientInstanceId: ClientInstanceId;
  now(): Date;
  datasets?: WorkflowDatasets;
  beginStep(
    tx: PlatformStores,
    run: WorkflowRun,
    step: WorkflowStep,
    place: StepPlace
  ): Promise<boolean>;
  advance(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    stepRun: WorkflowStepRun
  ): Promise<void>;
  failLoop(
    tx: PlatformStores,
    run: WorkflowRun,
    loop: WorkflowStepRun,
    error: import("@work-shape/catalyst-core").WorkflowRunError
  ): Promise<void>;
  continueRun(
    tx: PlatformStores,
    run: WorkflowRun,
    loopRun: WorkflowStepRun,
    loop: Extract<WorkflowStep, { type: "loop" }>,
    completed: number
  ): Promise<boolean>;
  completeDatasets(tx: PlatformStores, run: WorkflowRun, stepRun: WorkflowStepRun): Promise<void>;
}) {
  const { clientInstanceId, now, datasets, beginStep, advance, completeDatasets } = options;
  /** Where the first step of one item of a loop stands, with what labels the item. */
  async function itemPlace(
    tx: PlatformStores,
    index: WorkflowStepIndex,
    loopRun: WorkflowStepRun,
    first: WorkflowStep,
    iteration: number
  ): Promise<StepPlace> {
    const loop = index.get(loopRun.stepId)?.step;
    let item =
      loop?.type === "loop" && loop.itemLabel !== undefined
        ? await tx.workflowRuns.readLoopItem({ clientInstanceId, id: loopRun.id, index: iteration })
        : undefined;
    if (!item && datasets && loop?.type === "loop" && loop.itemLabel && loop.batch === undefined) {
      const dataset = await tx.workflowRuns.readLoopDataset({ clientInstanceId, id: loopRun.id });
      if (dataset) {
        const reader = await datasets.reader({
          id: dataset.$dataset,
          runId: loopRun.runId,
          offset: iteration,
          limit: 1,
          reference: dataset
        });
        for await (const row of reader.rows) item = { value: row };
      }
    }
    const label =
      item && loop?.type === "loop" && loop.itemLabel !== undefined
        ? itemLabelOf(item.value, loop.itemLabel)
        : undefined;
    return {
      key: `${loopRun.key}[${iteration}].${first.id}`,
      containerStepRunId: loopRun.id,
      iteration: { index: iteration, ...(label === undefined ? {} : { label }) }
    };
  }

  /**
   * Carries a loop on after it read its list and after each item that ended: starts the next
   * items in the order of the list while fewer than the loop's `concurrency` are going, and
   * ends the loop when none is going and none is left. It runs behind the lock of the run, so
   * two items that end at the same moment start two different next items. The loop's output
   * is its counts as they then stand, the failed items it continued past among them, and
   * never a result of an item.
   */
  async function fillLoop(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    loopRun: WorkflowStepRun
  ): Promise<void> {
    const loopRef: WorkflowStepRunRef = { clientInstanceId, id: loopRun.id };
    const loop = index.get(loopRun.stepId)?.step;
    const first = loop?.type === "loop" ? loop.steps[0] : undefined;
    // A definition nothing checked may name more than a loop may run at once.
    const width = loop?.type === "loop" ? loopConcurrencyOf(loop) : 1;
    const total = (await tx.workflowRuns.countLoopItems(loopRef)) ?? 0;
    const progress = await tx.workflowRuns.readLoopProgress(loopRef);
    let started = progress.started;
    let going = progress.running;
    // Reserve a whole next item before admitting it. Already admitted items drain before the
    // checkpoint, so no call is skipped or repeated at a concurrency boundary.
    const reservation =
      loop?.type === "loop" && loop.continueAsNew
        ? await loopItemReservation(tx, run, index, loopRun, loop.steps)
        : 0;
    const mustContinue = () =>
      loop?.type === "loop" &&
      loop.continueAsNew &&
      started < total &&
      (Date.parse(run.deadlineAt) <= now().getTime() ||
        started >= (loop.continueAsNew.after ?? Infinity) ||
        (run.stepRunCount + (going + 1) * reservation > run.limits.stepRuns &&
          // An item larger than a fresh history runs alone and may checkpoint inside it.
          !(started === 0 && going === 0 && run.stepRunCount < run.limits.stepRuns)));
    while (first && started < total && going < width && !mustContinue()) {
      const place = await itemPlace(tx, index, loopRun, first, started);
      // The run ended at its limit of step runs: no further item starts.
      if (!(await beginStep(tx, run, first, place))) return;
      started += 1;
      going += 1;
    }
    if (going > 0) return;
    if (mustContinue() && loop?.type === "loop") {
      if (await options.continueRun(tx, run, loopRun, loop, started)) return;
      await options.failLoop(tx, run, loopRun, {
        code: "continuation_no_progress",
        message: "The run budget cannot complete one loop item"
      });
      return;
    }
    if (total > 0 && loop?.type === "loop" && loop.continueAsNew?.cursor !== undefined) {
      if (await options.continueRun(tx, run, loopRun, loop, started)) return;
    }
    const counts = await tx.workflowRuns.readLoopCounts(loopRef);
    const output: WorkflowLoopOutput = {
      total: counts?.total ?? 0,
      done: counts?.done ?? 0,
      failed: counts?.failed ?? 0
    };
    let failures: import("@work-shape/catalyst-core").WorkflowDatasetReference | undefined;
    if (datasets && loop?.type === "loop" && loop.onItemFailure === "continue") {
      async function* failedRows() {
        let after: readonly (string | number)[] | undefined;
        for (;;) {
          const page = await tx.workflowRuns.listStepRuns({
            clientInstanceId,
            runId: run.id,
            filter: { containerStepRunId: loopRun.id, status: "failed" },
            page: { limit: 100, ...(after ? { after } : {}) }
          });
          for (const row of page)
            if (row.iteration) {
              yield {
                index: row.iteration.index,
                ...(row.iteration.label ? { label: row.iteration.label } : {}),
                code: row.error?.code ?? "step_failed"
              };
            }
          if (page.length < 100) break;
          const last = page.at(-1);
          if (last) after = [last.createdAt, last.id];
        }
      }
      try {
        failures = await datasets.write({
          run,
          stepRun: loopRun,
          field: "failures",
          rowSchema: loopFailureRowSchema,
          rows: failedRows(),
          transaction: tx
        });
      } catch (error) {
        if (!(error instanceof WorkflowStepFailure)) throw error;
        await options.failLoop(tx, run, loopRun, error.toRunError());
        return;
      }
    }
    await tx.workflowRuns.endStepRun({
      ...loopRef,
      status: "done",
      finishedAt: now().toISOString(),
      output: { ...output, ...(failures ? { failures: { ...failures } } : {}) }
    });
    await completeDatasets(tx, run, loopRun);
    await advance(tx, run, index, loopRun);
  }

  return fillLoop;
}
