import {
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  workflowStepJobKind
} from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
  WORKFLOW_STEP_JOB_MAX_ATTEMPTS
} from "./limits";

// The job that executes one step run is defined in core: the store queues it too, when an
// Operation Run that a step waits for ends.
export { workflowStepJobKind };

/**
 * The job kind of the script of one code step. It is served by the command worker, the one
 * process of an instance that reaches the sandbox, and by no other: the engine hands the step
 * over with it and takes the step up again when the script has ended.
 */
export const WORKFLOW_CODE_JOB_KIND = "workflow_run.run_code";

export const workflowCodeJobKind = defineJobKind({
  kind: WORKFLOW_CODE_JOB_KIND,
  payloadSchema: z.strictObject({ stepRunId: z.string().min(1) }),
  // A container that could not be started is tried again; a script that ended is not.
  maxAttempts: WORKFLOW_STEP_JOB_MAX_ATTEMPTS,
  backoff: { baseMs: WORKFLOW_STEP_JOB_BACKOFF_BASE_MS, maxMs: WORKFLOW_STEP_JOB_BACKOFF_MAX_MS },
  // A worker that was killed is noticed after two minutes, and its script is run again.
  leaseMs: 2 * 60 * 1_000,
  heartbeatMs: 30 * 1_000,
  concurrency: {}
});

/**
 * The job kind that removes what a killed command worker left of code steps: containers no
 * process will end, and the directories they were handed. A schedule runs it when a worker
 * starts and every ten minutes after, whether or not another code step ever runs.
 */
export const WORKFLOW_CODE_SWEEP_JOB_KIND = "workflow_run.sweep_code";

export const workflowCodeSweepJobKind = defineJobKind({
  kind: WORKFLOW_CODE_SWEEP_JOB_KIND,
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 2 * 60 * 1_000,
  concurrency: { global: 1 },
  // The next tick is the retry of a failed one.
  manualRetry: false
});

export const workflowCodeSweepSchedule = defineSchedule({
  kind: workflowCodeSweepJobKind,
  every: 10 * 60 * 1_000,
  dueAtStart: true
});

/** The key of the step job that takes a code step up again once its script has ended. */
export function codeStepContinuationKey(stepRunId: string): string {
  return `${workflowStepJobKind.kind}:${stepRunId}:after_code`;
}
