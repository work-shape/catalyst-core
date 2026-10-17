import { z } from "zod";
import { defineJobKind } from "./jobs";
import { WORKFLOW_RUN_JOB_KINDS } from "./workflows";

// The job that executes one step run of a Workflow Run. It is defined here and not with the
// engine because the store queues it too: the end of an Operation Run that a step waits for
// wakes that step in the same transaction (EW-ASYNC).

/**
 * How often the job of one step is attempted. A step whose process died is run again; a
 * changing call it made answers its first result, by the step run's idempotency key.
 */
export const WORKFLOW_STEP_JOB_MAX_ATTEMPTS = 3;

/** The wait before the second attempt of a step. It doubles up to the maximum. */
export const WORKFLOW_STEP_JOB_BACKOFF_BASE_MS = 2_000;
export const WORKFLOW_STEP_JOB_BACKOFF_MAX_MS = 60_000;

/**
 * After this long without a heartbeat a running step counts as abandoned and is attempted
 * again: a step whose process was killed is taken up within about this time. The lengths are
 * those of an Agent Run's job (`AGENT_RUN_LEASE_MS`, `AGENT_RUN_HEARTBEAT_MS`), and like them
 * no setting of a release changes them.
 */
export const WORKFLOW_STEP_JOB_LEASE_MS = 90 * 1_000;

/**
 * How often the process that holds a step's job renews its lease while the step runs, however
 * long that is. Five heartbeats may be lost before the lease ends.
 */
export const WORKFLOW_STEP_JOB_HEARTBEAT_MS = 15 * 1_000;

/** The job that executes one step run. Its payload names the step run and nothing else. */
export const workflowStepJobKind = defineJobKind({
  kind: WORKFLOW_RUN_JOB_KINDS.executeStep,
  payloadSchema: z.strictObject({ stepRunId: z.string().min(1) }),
  maxAttempts: WORKFLOW_STEP_JOB_MAX_ATTEMPTS,
  backoff: { baseMs: WORKFLOW_STEP_JOB_BACKOFF_BASE_MS, maxMs: WORKFLOW_STEP_JOB_BACKOFF_MAX_MS },
  leaseMs: WORKFLOW_STEP_JOB_LEASE_MS,
  heartbeatMs: WORKFLOW_STEP_JOB_HEARTBEAT_MS,
  concurrency: {}
});

/**
 * The key of the step job that the end of an Operation Run queues for a step that waits for
 * it. One wake per step run is queued at a time.
 */
export function operationWakeKey(stepRunId: string): string {
  return `${workflowStepJobKind.kind}:${stepRunId}:after_operation`;
}

/** The key of the step job that ends the wait of a step at its `timeout`. */
export function operationTimeoutKey(stepRunId: string): string {
  return `${workflowStepJobKind.kind}:${stepRunId}:operation_timeout`;
}
