import {
  operationWakeKey,
  workflowStepJobKind,
  type OperationRun
} from "@work-shape/catalyst-core";
import { and, eq } from "drizzle-orm";
import { enqueueJob } from "./jobs/store";
import type { PostgresConnection } from "./postgres-database";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";

/**
 * Queues the job of every `operation` step that waits for this Operation Run, once the run has
 * ended, in the transaction that ended it. The step runs are read and not locked: the lock
 * order of a Workflow Run is run, then step run, and the engine holds the Operation Run while
 * it moves a step to `waiting`, so this read sees every step that waits. Answers whether it
 * queued a job.
 */
export async function wakeStepsWaitingFor(
  tx: PostgresConnection,
  run: OperationRun
): Promise<boolean> {
  if (run.status !== "done" && run.status !== "failed" && run.status !== "denied") return false;
  const waiting = await tx
    .select({
      id: workflowStepRuns.id,
      runId: workflowStepRuns.runId,
      correlationId: workflowRuns.correlationId
    })
    .from(workflowStepRuns)
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.clientInstanceId, workflowStepRuns.clientInstanceId),
        eq(workflowRuns.id, workflowStepRuns.runId)
      )
    )
    .where(
      and(
        eq(workflowStepRuns.operationRunId, run.id),
        eq(workflowStepRuns.status, "waiting"),
        eq(workflowStepRuns.clientInstanceId, run.clientInstanceId),
        eq(workflowStepRuns.stepType, "operation")
      )
    );
  for (const step of waiting) {
    await enqueueJob(
      tx,
      workflowStepJobKind,
      { stepRunId: step.id },
      {
        clientInstanceId: run.clientInstanceId,
        subject: step.id,
        dedupeKey: operationWakeKey(step.id),
        concurrencyKey: step.runId,
        correlationId: step.correlationId
      }
    );
  }
  return waiting.length > 0;
}
