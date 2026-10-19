import { workflowFailureNoticeJob } from "./failure-notices";
import {
  WORKFLOW_ENDED_STATUSES,
  isWorkflowRunEnded,
  type AuditActor,
  type ClientInstanceId,
  type JsonValue,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowRunError
} from "@work-shape/catalyst-core";
import { stepJobConcurrency, workflowStepJobKind } from "./step-job";
import { workflowDeadlineJobKind, workflowDeadlineKey } from "./run-deadline";

/** Parent and child ends share one transaction, including the parent's wakeup. */
export function createRunEnd(options: {
  clientInstanceId: ClientInstanceId;
  now(): Date;
  datasetEnd(tx: PlatformStores, run: WorkflowRun, output: JsonValue | undefined): Promise<void>;
  cancelWaiting(tx: PlatformStores, run: WorkflowRun): Promise<void>;
}) {
  const { clientInstanceId, now, cancelWaiting } = options;
  /**
   * Ends a run that has not ended, with every step run that still waits for its turn. A
   * step run that is running is left to its attempt, which records how its call went and
   * starts nothing after it. Descendant cancellations retain the initiating actor and
   * correlation id. Answers whether this call ended the run.
   */
  async function endRun(
    tx: PlatformStores,
    run: WorkflowRun,
    end: {
      status: (typeof WORKFLOW_ENDED_STATUSES)[number];
      output?: JsonValue;
      error?: WorkflowRunError;
      cancelledBy?: WorkflowRun["cancelledBy"];
    },
    audit: { actor: AuditActor; correlationId: string }
  ): Promise<boolean> {
    const finishedAt = now().toISOString();
    const ended = await tx.workflowRuns.endRun({
      clientInstanceId,
      id: run.id,
      finishedAt,
      ...end
    });
    if (!ended) return false;
    if (end.status !== "continued")
      await options.datasetEnd(tx, { ...run, status: end.status }, end.output);
    await cancelWaiting(tx, run);
    await tx.childAgentRuns.cancelWorkflowAgentRuns({ clientInstanceId, runId: run.id });
    await tx.jobs.withdraw(workflowDeadlineJobKind, {
      clientInstanceId,
      dedupeKey: workflowDeadlineKey(run.id)
    });
    if (end.status === "continued") return true;
    for (const child of await tx.workflowRuns.listChildRuns({ clientInstanceId, id: run.id })) {
      if (isWorkflowRunEnded(child.status)) continue;
      const locked = await tx.workflowRuns.lockRun({ clientInstanceId, id: child.id });
      if (
        !locked ||
        !(await endRun(
          tx,
          locked,
          {
            status: "cancelled",
            ...(end.cancelledBy ? { cancelledBy: end.cancelledBy } : {})
          },
          audit
        ))
      )
        continue;
      await tx.audit.appendAuditEvent({
        clientInstanceId,
        type: "workflow_run.cancelled",
        status: "success",
        actor: audit.actor,
        subject: locked.id,
        correlationId: audit.correlationId,
        metadata: {
          workflow: locked.workflow,
          definitionRevisionId: locked.definitionRevisionId,
          stepRunCount: locked.stepRunCount,
          parentRunId: run.id
        }
      });
    }
    if (!run.parentRunId && run.mode !== "test") {
      await tx.jobs.enqueue(
        workflowFailureNoticeJob,
        { rootRunId: run.id },
        {
          clientInstanceId,
          subject: run.id,
          dedupeKey: `${workflowFailureNoticeJob.kind}:${run.id}`,
          correlationId: run.correlationId
        }
      );
    }
    // The step that owns the run, and every step a run key linked to it, wake to its end. A
    // link is written behind this run's lock, so this read sees every link made before.
    const waiting = [
      ...(run.parentStepRunId ? [run.parentStepRunId] : []),
      ...(await tx.workflowRuns.listLinkedStepRuns({ clientInstanceId, id: run.id }))
    ];
    for (const stepRunId of waiting) {
      // The step counts against the slots of its own run's root: a child shares its parent's,
      // and a step linked from another run is read for its own.
      const owner = stepRunId === run.parentStepRunId ? run : await runOfStep(tx, stepRunId);
      await tx.jobs.enqueue(
        workflowStepJobKind,
        { stepRunId },
        {
          clientInstanceId,
          subject: stepRunId,
          dedupeKey: `${workflowStepJobKind.kind}:${stepRunId}:after_child`,
          ...(owner ? stepJobConcurrency(owner) : {}),
          correlationId: run.correlationId
        }
      );
    }
    return true;
  }

  /** The run a step run belongs to, for the slots its wake counts against. */
  async function runOfStep(
    tx: PlatformStores,
    stepRunId: string
  ): Promise<WorkflowRun | undefined> {
    const stepRun = await tx.workflowRuns.getStepRun({ clientInstanceId, id: stepRunId });
    return stepRun ? tx.workflowRuns.readRun({ clientInstanceId, id: stepRun.runId }) : undefined;
  }

  return endRun;
}
