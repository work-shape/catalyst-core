// The bounds of one Workflow Run. Each is a constant of the release: no setting raises one.

/**
 * How many step runs one run may create, the steps of every loop iteration among them. A run
 * that would create one more ends as `limit_reached`. This is the limit that binds a loop:
 * each item takes one step run per step of the loop, so a loop of two steps runs at most
 * some 10,000 items less the steps outside it, and one of five steps some 4,000. Only a loop
 * of one step reaches `WORKFLOW_LOOP_MAX_ITEMS` first.
 */
export const WORKFLOW_RUN_MAX_STEP_RUNS = 20_000;

/**
 * How long a run may take from its start. No step starts after it, and the run then ends as
 * `limit_reached`. Twelve hours cover a nightly batch and end a run that hangs before the
 * next one is due.
 */
export const WORKFLOW_RUN_MAX_DURATION_MS = 12 * 60 * 60 * 1_000;

/** How many items the list of one loop may hold. A longer list fails the loop step. */
export const WORKFLOW_LOOP_MAX_ITEMS = 10_000;

/**
 * How large the input or the output of one step may be, as JSON in UTF-8. Step data is kept
 * in the run's rows and read by the steps after it, so a larger value fails the step.
 */
export const WORKFLOW_STEP_DATA_MAX_BYTES = 256 * 1_024;

/** How large `workflow.yaml` may be. A larger file is not read as a definition. */
export const WORKFLOW_MANIFEST_MAX_BYTES = 256 * 1_024;

/**
 * How deep the values of `workflow.yaml` may nest, lists and objects alike. Sixteen blocks,
 * each with its steps, their mappings and their schemas, stay far below it.
 */
export const WORKFLOW_MANIFEST_MAX_NESTING = 256;

/** How many steps a definition may hold, the steps of its loops among them. */
export const WORKFLOW_DEFINITION_MAX_STEPS = 200;

/**
 * How many characters of an item's label a step run keeps. The label tells one iteration of a
 * loop from the next on a page, so a longer value is cut.
 */
export const WORKFLOW_ITERATION_LABEL_MAX_CHARS = 120;

// The attempts, backoff and lease of a step's job are the job kind's, which the store queues
// too (`workflowStepJobKind`).
export {
  WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
  WORKFLOW_STEP_JOB_HEARTBEAT_MS,
  WORKFLOW_STEP_JOB_LEASE_MS,
  WORKFLOW_STEP_JOB_MAX_ATTEMPTS
} from "@work-shape/catalyst-core";

/**
 * The longest a step waits for a changing call that an earlier attempt of it started and that
 * has no outcome yet, counted from the start of that call. The wait is the time the call's
 * operation gives a call (`timeoutMs`) where that is shorter, which it is for every
 * operation of this release: a call without an outcome after it was cut off with its process,
 * and nobody will write one.
 */
export const WORKFLOW_OPERATION_OUTCOME_WAIT_MS = 10 * 60 * 1_000;

/** The bounds a run is started under. A test starts an engine with smaller ones. */
export interface WorkflowRunLimits {
  operationOutcomeWaitMs: number;
  maxStepRuns: number;
  maxDurationMs: number;
  loopMaxItems: number;
  stepDataMaxBytes: number;
}

export const WORKFLOW_RUN_LIMITS: WorkflowRunLimits = {
  operationOutcomeWaitMs: WORKFLOW_OPERATION_OUTCOME_WAIT_MS,
  maxStepRuns: WORKFLOW_RUN_MAX_STEP_RUNS,
  maxDurationMs: WORKFLOW_RUN_MAX_DURATION_MS,
  loopMaxItems: WORKFLOW_LOOP_MAX_ITEMS,
  stepDataMaxBytes: WORKFLOW_STEP_DATA_MAX_BYTES
};
