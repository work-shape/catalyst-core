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
import { workflowStepJobKind } from "./step-job";
import { workflowDeadlineJobKind } from "./run-deadline";

/** Parent and child ends share one transaction, including the parent's wakeup. */
export function createRunEnd(options: {
  clientInstanceId: ClientInstanceId;
  now(): Date;
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
    await cancelWaiting(tx, run);
    await tx.jobs.withdraw(workflowDeadlineJobKind, {
      clientInstanceId,
      dedupeKey: `${workflowDeadlineJobKind.kind}:${run.id}`
    });
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
    // The step that owns the run, and every step a run key linked to it, wake to its end. A
    // link is written behind this run's lock, so this read sees every link made before.
    const waiting = [
      ...(run.parentStepRunId ? [run.parentStepRunId] : []),
      ...(await tx.workflowRuns.listLinkedStepRuns({ clientInstanceId, id: run.id }))
    ];
    for (const stepRunId of waiting) {
      await tx.jobs.enqueue(
        workflowStepJobKind,
        { stepRunId },
        {
          clientInstanceId,
          subject: stepRunId,
          dedupeKey: `${workflowStepJobKind.kind}:${stepRunId}:after_child`,
          correlationId: run.correlationId
        }
      );
    }
    return true;
  }

  return endRun;
}
