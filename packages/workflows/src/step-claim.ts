import {
  isWorkflowRunEnded,
  type ClientInstanceId,
  type PlatformStores,
  type JobControl,
  type OperationRun,
  type WorkflowRun,
  type WorkflowStepRun,
  type WorkflowStepRunRef,
  type WorkflowCodeOutcome,
  type WorkflowRunError
} from "@work-shape/catalyst-core";
import { operationWaitMs } from "./operation-wait";
import { childStepOutcome } from "./child-runs";
import { indexWorkflowSteps } from "./definition";
import type { createRunWaiting } from "./run-waiting";
import { workflowDurationText } from "./run-limits";
import type { createStepExecutor } from "./step-execution";
interface OperationWake {
  waited: OperationRun;
  timedOut: boolean;
}
export function createStepClaim(options: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  now(): Date;
  waiting: ReturnType<typeof createRunWaiting>;
  executor: ReturnType<typeof createStepExecutor>;
  finishRun(
    tx: PlatformStores,
    run: WorkflowRun,
    end: { status: "limit_reached"; error: WorkflowRunError }
  ): Promise<void>;
}) {
  const { clientInstanceId, now, waiting, executor, finishRun } = options;
  /**
   * Takes a step run up for one attempt. Answers nothing where there is nothing to execute:
   * the step run has ended, its run has ended, or the run is past its time.
   */
  async function claim(
    control: JobControl,
    ref: WorkflowStepRunRef,
    byTimeout: boolean
  ): Promise<
    | {
        run: WorkflowRun;
        stepRun: WorkflowStepRun;
        afterCode?: WorkflowCodeOutcome;
        afterOperation?: OperationWake;
      }
    | undefined
  > {
    return control.transaction(async (tx) => {
      const found = await tx.workflowRuns.getStepRun(ref);
      if (!found) return undefined;
      const chain = await waiting.lockChain(tx, found.runId);
      // Read again behind the lock: a cancel may have ended it in between.
      const stepRun = await tx.workflowRuns.getStepRun(ref);
      if (!chain || !stepRun) return undefined;
      let run = chain.run;
      // A code step waits while the command worker runs its script, and is taken up again
      // when the script has ended. Nothing else that waits is executed by a step job.
      const afterChild =
        stepRun.status === "waiting" && stepRun.stepType === "workflow"
          ? await childStepOutcome(tx, run, stepRun)
          : undefined;
      const afterCode =
        stepRun.status === "waiting" && stepRun.stepType === "code"
          ? await tx.workflowRuns.readCodeOutcome(ref)
          : undefined;
      // The timeout job again after its worker died with the step taken up: the step ends
      // the wait from when it began, and does not wait again on the timer of this very job.
      const afterOperation =
        stepRun.stepType === "operation" &&
        (stepRun.status === "waiting" || (stepRun.status === "running" && byTimeout))
          ? await operationWake(tx, run, stepRun)
          : undefined;
      if (
        stepRun.status !== "queued" &&
        stepRun.status !== "running" &&
        !afterCode &&
        !afterChild &&
        !afterOperation
      ) {
        return undefined;
      }
      // The step is taken up: the time the run waited moves its deadline before it is asked.
      if (!isWorkflowRunEnded(run.status)) run = await waiting.endWaits(tx, chain);
      const moment = now();
      const finishedAt = moment.toISOString();
      const ended = isWorkflowRunEnded(run.status);
      const definition =
        !ended && stepRun.containerStepRunId !== undefined
          ? await tx.workflowRuns.readRunDefinition({ clientInstanceId, id: run.id })
          : undefined;
      const index = definition ? indexWorkflowSteps(definition) : undefined;
      let container = stepRun.containerStepRunId;
      let drains = false;
      while (container && !drains) {
        const parent = await tx.workflowRuns.getStepRun({ clientInstanceId, id: container });
        const loop = parent ? index?.get(parent.stepId)?.step : undefined;
        drains = loop?.type === "loop" && loop.continueAsNew !== undefined;
        container = parent?.containerStepRunId;
      }
      if (ended || (!drains && moment.getTime() >= Date.parse(run.deadlineAt))) {
        // The step does not run: its run was cancelled or ended, or is past its time. An
        // attempt nobody ended may have made its call before its worker was gone, and then
        // the step run says what the call did and not that nothing happened.
        const known =
          stepRun.status === "running"
            ? await executor.knownCallEnd(tx, run, stepRun, finishedAt)
            : undefined;
        await tx.workflowRuns.endStepRun({
          ...ref,
          ...(known ?? { status: "cancelled", finishedAt })
        });
        if (ended) return undefined;
        await finishRun(tx, run, {
          status: "limit_reached",
          error: {
            code: "duration_limit",
            message: `The run did not end within its run time of ${workflowDurationText(run.limits.durationMs)}`,
            stepRunId: stepRun.id
          }
        });
        return undefined;
      }
      await tx.workflowRuns.markRunRunning({ clientInstanceId, id: run.id, startedAt: finishedAt });
      await tx.workflowRuns.markStepRunRunning({
        ...ref,
        attempt: control.attempt,
        startedAt: finishedAt
      });
      // The first step of a run starts it: the trigger step hands that moment on.
      return {
        run: { ...run, startedAt: run.startedAt ?? finishedAt },
        stepRun: { ...stepRun, startedAt: stepRun.startedAt ?? finishedAt },
        ...(afterCode ? { afterCode } : {}),
        ...(afterOperation ? { afterOperation } : {})
      };
    });
  }

  /**
   * Why a step that waits for an Operation Run is taken up: the run ended, or the step's
   * `timeout` passed while it goes on. Nothing while the step has more time: a job that comes
   * early leaves the step waiting.
   */
  async function operationWake(
    tx: PlatformStores,
    run: WorkflowRun,
    stepRun: WorkflowStepRun
  ): Promise<OperationWake | undefined> {
    if (stepRun.operationRunId === undefined) return undefined;
    const waited = await tx.operationRuns.get({ clientInstanceId, id: stepRun.operationRunId });
    if (!waited) return undefined;
    if (waited.status !== "running") return { waited, timedOut: false };
    const definition = await tx.workflowRuns.readRunDefinition({ clientInstanceId, id: run.id });
    const step = definition ? indexWorkflowSteps(definition).get(stepRun.stepId)?.step : undefined;
    const waitMs = operationWaitMs(step?.type === "operation" ? step.timeout : undefined);
    const since = Date.parse(stepRun.startedAt ?? stepRun.createdAt);
    return now().getTime() >= since + waitMs ? { waited, timedOut: true } : undefined;
  }

  return claim;
}
