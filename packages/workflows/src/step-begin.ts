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
import { indexWorkflowSteps, type WorkflowStepIndex } from "./definition";
import { stepJobConcurrency, workflowStepJobKind } from "./step-job";
import { checkpointFrame } from "./continuation-checkpoint";
import type { createContinuation } from "./continue-as-new";
type StepPlace = WorkflowStepRunPlacement & { key: string };

/** The sole admission path: count, persist and queue a step, or checkpoint its exact frontier. */
export function createStepBeginning(options: {
  clientInstanceId: ClientInstanceId;
  now(): Date;
  continueRun: ReturnType<typeof createContinuation>;
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
    place: StepPlace
  ): Promise<boolean> {
    if (run.stepRunCount >= run.limits.stepRuns) {
      if (place.containerStepRunId !== undefined) {
        const definition = await tx.workflowRuns.readRunDefinition({
          clientInstanceId,
          id: run.id
        });
        const index = indexWorkflowSteps(definition ?? { steps: [] });
        const loopRun = await tx.workflowRuns.getStepRun({
          clientInstanceId,
          id: place.containerStepRunId
        });
        const loop = loopRun ? index.get(loopRun.stepId)?.step : undefined;
        let parent = loopRun;
        let configuration = loop?.type === "loop" ? loop.continueAsNew : undefined;
        while (!configuration && parent?.containerStepRunId) {
          parent = await tx.workflowRuns.getStepRun({
            clientInstanceId,
            id: parent.containerStepRunId
          });
          const ancestor = parent ? index.get(parent.stepId)?.step : undefined;
          if (ancestor?.type === "loop") configuration = ancestor.continueAsNew;
        }
        if (
          configuration &&
          loopRun &&
          loop?.type === "loop" &&
          (await options.continueRun(
            tx,
            run,
            loopRun,
            { ...loop, continueAsNew: configuration },
            place.iteration?.index ?? 0,
            step.id
          ))
        )
          return false;
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
    if (place.containerStepRunId !== undefined && place.iteration?.index === 0) {
      const container = await tx.workflowRuns.getStepRun({
        clientInstanceId,
        id: place.containerStepRunId
      });
      const frame = container ? await checkpointFrame(tx, run, container) : undefined;
      const output =
        frame?.completed && Object.hasOwn(frame.completed, step.id)
          ? frame.completed[step.id]
          : undefined;
      if (output !== undefined) {
        await tx.workflowRuns.endStepRun({
          clientInstanceId,
          id: stepRun.id,
          status: "done",
          finishedAt: now().toISOString(),
          output
        });
        const definition = await tx.workflowRuns.readRunDefinition({
          clientInstanceId,
          id: run.id
        });
        await options.advance(tx, run, indexWorkflowSteps(definition ?? { steps: [] }), stepRun);
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
  };
}
