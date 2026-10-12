// The bounds of one Workflow Run. Each is a constant of the release: no setting raises one.

/**
 * How many step runs one run may create, the steps of every loop iteration among them. A run
 * that would create one more ends as `limit_reached`. A loop over the largest list with a
 * handful of steps per item fits; a definition that never ends does not.
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

/** How many steps a definition may hold, the steps of its loops among them. */
export const WORKFLOW_DEFINITION_MAX_STEPS = 200;

/**
 * How many characters of an item's label a step run keeps. The label tells one iteration of a
 * loop from the next on a page, so a longer value is cut.
 */
export const WORKFLOW_ITERATION_LABEL_MAX_CHARS = 120;

/** How many jobs of the step kind one process runs at once. */
export const WORKFLOW_STEP_JOB_SLOTS = 4;

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
 * again. It is above the time one operation call may take by default.
 */
export const WORKFLOW_STEP_JOB_LEASE_MS = 10 * 60 * 1_000;

/** The bounds a run is started under. A test starts an engine with smaller ones. */
export interface WorkflowRunLimits {
  maxStepRuns: number;
  maxDurationMs: number;
  loopMaxItems: number;
  stepDataMaxBytes: number;
}

export const WORKFLOW_RUN_LIMITS: WorkflowRunLimits = {
  maxStepRuns: WORKFLOW_RUN_MAX_STEP_RUNS,
  maxDurationMs: WORKFLOW_RUN_MAX_DURATION_MS,
  loopMaxItems: WORKFLOW_LOOP_MAX_ITEMS,
  stepDataMaxBytes: WORKFLOW_STEP_DATA_MAX_BYTES
};
