import {
  createPlatformId,
  subjectDedupeKey,
  type ClientInstanceId,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowStepRun,
  type WorkflowStepRunPlacement,
  type WorkflowRunError
} from "@work-shape/catalyst-core";
import type { WorkflowStepIndex } from "./definition";
import { stepJobConcurrency, workflowStepJobKind } from "./step-job";
import { loopContinuation } from "./loop-reservation";
import { checkpointFrame } from "./continuation-checkpoint";
import type { createContinuation } from "./continue-as-new";
type StepPlace = WorkflowStepRunPlacement & { key: string };

/** The sole admission path: count, persist and queue a step, or checkpoint its exact frontier. */
export function createStepBeginning(options: {
  clientInstanceId: ClientInstanceId;
  now(): Date;
  continueRun: (...args: Parameters<ReturnType<typeof createContinuation>>) => Promise<boolean>;
  failStep(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    step: WorkflowStepRun,
    error: WorkflowRunError
  ): Promise<void>;
  advance(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    step: WorkflowStepRun
  ): Promise<void>;
  finishRun(
    tx: PlatformStores,
    run: WorkflowRun,
    end: { status: "limit_reached"; error: WorkflowRunError }
  ): Promise<void>;
}) {
  const { clientInstanceId, now, finishRun } = options;
  return async function beginStep(
    tx: PlatformStores,
    run: WorkflowRun,
    step: WorkflowStep,
    place: StepPlace,
    index: WorkflowStepIndex = new Map()
  ): Promise<boolean> {
    let sequence = index.get(step.id)?.sequence;
    while (sequence && !sequence.loop) sequence = sequence.parent;
    const loopId = sequence?.loop;
    const loop = loopId ? index.get(loopId)?.step : undefined;
    const configuration = loopId ? loopContinuation(index, loopId) : undefined;
    // A requested handoff drains admitted concurrent items, even beyond the history budget.
    // The barrier pauses every other queued step before it is claimed.
    if ((await tx.workflowRuns.readCheckpoint({ clientInstanceId, id: run.id }))?.pending)
      return admitStep();
    // Loop admission already reserves enclosing tails, also for plain nested loops.
    if (run.stepRunCount >= run.limits.stepRuns) {
      let loopRun =
        place.containerStepRunId === undefined
          ? undefined
          : await tx.workflowRuns.getStepRun({ clientInstanceId, id: place.containerStepRunId });
      let iteration = place.iteration?.index ?? 0;
      while (loopRun && loopRun.stepType !== "loop") {
        iteration = loopRun.iteration?.index ?? 0;
        loopRun = loopRun.containerStepRunId
          ? await tx.workflowRuns.getStepRun({ clientInstanceId, id: loopRun.containerStepRunId })
          : undefined;
      }
      if (loopRun) {
        let parent: WorkflowStepRun | undefined = loopRun;
        let quiet = true;
        let childIndex = iteration;
        // A single frontier cannot represent unfinished siblings or later completed items.
        // Drain those admitted items; fillLoop will checkpoint their common quiet boundary.
        while (parent) {
          const progress = await tx.workflowRuns.readLoopProgress({
            clientInstanceId,
            id: parent.id
          });
          const alreadyStarted = progress.started > childIndex;
          if (progress.running > (alreadyStarted ? 1 : 0) || progress.started > childIndex + 1)
            quiet = false;
          childIndex = parent.iteration?.index ?? 0;
          parent = parent.containerStepRunId
            ? await tx.workflowRuns.getStepRun({
                clientInstanceId,
                id: parent.containerStepRunId
              })
            : undefined;
        }
        if (
          quiet &&
          configuration &&
          loop?.type === "loop" &&
          (await options.continueRun(
            tx,
            run,
            loopRun,
            { ...loop, continueAsNew: configuration },
            iteration,
            step.id
          ))
        )
          return false;
        if (configuration && !quiet) return admitStep();
      }
      await finishRun(tx, run, {
        status: "limit_reached",
        error: {
          code: "step_limit",
          message: `The run reached its limit of ${run.limits.stepRuns} steps`
        }
      });
      return false;
    }
    return admitStep();

    async function admitStep(): Promise<boolean> {
      // The run was read when its row was locked: what this transaction adds is counted here.
      run.stepRunCount += 1;
      // A step run is created between two steps, and so between two items of a loop. `claim`
      // starts none of a run that was cancelled or is past its time.
      const stepRun = await tx.workflowRuns.createStepRun({
        id: createPlatformId<"WorkflowStepRunId">("wfs"),
        clientInstanceId,
        runId: run.id,
        stepId: step.id,
        stepType: step.type,
        createdAt: now().toISOString(),
        ...place
      });
      if (
        place.containerStepRunId !== undefined &&
        (place.iteration === undefined || place.iteration.index === 0)
      ) {
        const container = await tx.workflowRuns.getStepRun({
          clientInstanceId,
          id: place.containerStepRunId
        });
        const frame = container ? await checkpointFrame(tx, run, container) : undefined;
        const output =
          frame?.completed && Object.hasOwn(frame.completed, step.id)
            ? frame.completed[step.id]
            : undefined;
        const failure = frame?.failed?.[step.id];
        if (failure) {
          await tx.workflowRuns.endStepRun({
            clientInstanceId,
            id: stepRun.id,
            status: "failed",
            finishedAt: now().toISOString(),
            error: failure
          });
          await options.failStep(tx, run, index, stepRun, failure);
          return true;
        }
        if (output !== undefined) {
          await tx.workflowRuns.endStepRun({
            clientInstanceId,
            id: stepRun.id,
            status: "done",
            finishedAt: now().toISOString(),
            output
          });
          await options.advance(tx, run, index, stepRun);
          return true;
        }
      }
      await tx.jobs.enqueue(
        workflowStepJobKind,
        { stepRunId: stepRun.id },
        {
          clientInstanceId,
          subject: stepRun.id,
          dedupeKey: subjectDedupeKey(workflowStepJobKind.kind, stepRun.id),
          // The runs of the root Workflow and their children share its slots, counted at the
          // claim of every worker of the instance.
          ...stepJobConcurrency(run),
          correlationId: run.correlationId
        }
      );
      return true;
    }
  };
}
