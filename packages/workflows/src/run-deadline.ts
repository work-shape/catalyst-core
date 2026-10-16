import {
  defineJobHandler,
  isWorkflowRunEnded,
  type ClientInstanceId,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowRunError,
  defineJobKind
} from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  WORKFLOW_STEP_JOB_MAX_ATTEMPTS,
  WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
  WORKFLOW_STEP_JOB_LEASE_MS
} from "./limits";

/** A stored deadline wakes even a run whose only remaining work waits for a child. */
export const workflowDeadlineJobKind = defineJobKind({
  kind: "workflow_run.deadline",
  payloadSchema: z.strictObject({ runId: z.string().min(1) }),
  maxAttempts: WORKFLOW_STEP_JOB_MAX_ATTEMPTS,
  backoff: { baseMs: WORKFLOW_STEP_JOB_BACKOFF_BASE_MS, maxMs: WORKFLOW_STEP_JOB_BACKOFF_MAX_MS },
  leaseMs: WORKFLOW_STEP_JOB_LEASE_MS,
  concurrency: {}
});

export function createRunDeadline(options: {
  clientInstanceId: ClientInstanceId;
  now(): Date;
  finishRun(
    tx: PlatformStores,
    run: WorkflowRun,
    end: { status: "limit_reached"; error: WorkflowRunError }
  ): Promise<void>;
}) {
  const { clientInstanceId, now, finishRun } = options;
  return defineJobHandler({
    kind: workflowDeadlineJobKind,
    slots: 1,
    async run(job, control) {
      await control.transaction(async (tx) => {
        const known = await tx.workflowRuns.readRun({ clientInstanceId, id: job.payload.runId });
        if (!known) return;
        const run = await tx.workflowRuns.lockRun({ clientInstanceId, id: known.id });
        if (
          run &&
          !isWorkflowRunEnded(run.status) &&
          now().getTime() >= Date.parse(run.deadlineAt)
        ) {
          await finishRun(tx, run, {
            status: "limit_reached",
            error: { code: "duration_limit", message: "The run reached its deadline" }
          });
        }
      });
    }
  });
}
