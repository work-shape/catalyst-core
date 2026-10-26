import {
  WORKFLOW_RUN_JOB_KINDS,
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  type ClientInstanceId,
  type JobSchedule,
  type PlatformStores,
  type RegisteredJobHandler,
  type WorkflowRunId
} from "@work-shape/catalyst-core";

// Run data is bounded. A run and its step runs stay as long as the instance keeps its audit
// events: status, times, counts and error codes. The values they carry do not: the inputs and
// outputs, staged code, logs, item labels, and the run's snapshot and checkpoint expire
// a number of days after the run ended. A run that has not ended keeps everything, however old it is: the step
// that carries it on reads the values of the steps before it.

const DAY_MS = 24 * 60 * 60 * 1_000;

/** For how many days after its end a run keeps its values, where release config names none. */
export const WORKFLOW_STEP_DATA_DAYS = 30;

/**
 * How many step runs one statement takes the values from. Each statement locks the rows it
 * changes and no other, and is its own transaction, so a table of any size is pruned without
 * one long lock: a run of 10,000 step runs is twenty short statements.
 */
const WORKFLOW_PRUNE_STEP_BATCH = 500;

/** How many runs the job reads at a time to prune them one by one. */
const WORKFLOW_PRUNE_RUN_BATCH = 100;

/**
 * The job that removes the values of the runs that are due. One tick at a time across the
 * instance; it works until nothing is due or its worker stops, and the next tick goes on.
 */
const workflowPruneDataJobKind = defineJobKind({
  kind: WORKFLOW_RUN_JOB_KINDS.pruneData,
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 2 * 60 * 1_000,
  heartbeatMs: 20 * 1_000,
  concurrency: { global: 1 },
  manualRetry: false
});

export interface WorkflowDataPruningOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  /** For how many days after its end a run keeps its values. */
  stepDataDays: number;
  /** Batch sizes below the release's own, for a test. */
  batch?: { stepRuns?: number; runs?: number };
  now(): Date;
  /** Dataset retention is swept on this same daily tick. */
  pruneDatasets?(signal?: AbortSignal): Promise<void>;
  /**
   * Deletes the files of one run before its values are marked pruned. Answers false where it
   * stopped for the signal; the run is found again on the next tick.
   */
  pruneRunFiles?(runId: WorkflowRunId, signal?: AbortSignal): Promise<boolean>;
}

export interface WorkflowDataPruning {
  handler: RegisteredJobHandler;
  /** Due when a process starts and then once a day. */
  schedule: JobSchedule;
  /**
   * Removes the values of every run that ended more than `stepDataDays` ago, in batches.
   * Also repairs rows marked by an older retention owner through the same bounded path.
   * Answers how many runs and step runs it took them from and how many statements changed
   * step runs. A second call finds nothing.
   */
  prune(signal?: AbortSignal): Promise<{ runs: number; stepRuns: number; batches: number }>;
}

export function createWorkflowDataPruning(
  options: WorkflowDataPruningOptions
): WorkflowDataPruning {
  const { clientInstanceId, stores, now } = options;
  const stepBatch = options.batch?.stepRuns ?? WORKFLOW_PRUNE_STEP_BATCH;
  const runBatch = options.batch?.runs ?? WORKFLOW_PRUNE_RUN_BATCH;

  async function prune(signal?: AbortSignal) {
    const endedBefore = new Date(now().getTime() - options.stepDataDays * DAY_MS).toISOString();
    await options.pruneDatasets?.(signal);
    const done = { runs: 0, stepRuns: 0, batches: 0 };
    for (;;) {
      const due = await stores.workflowRuns.listRunsWithDataEndedBefore({
        clientInstanceId,
        endedBefore,
        limit: runBatch
      });
      if (due.length === 0) return done;
      for (const id of due) {
        for (;;) {
          // A worker that stops leaves the rest to the next tick: nothing is half done.
          if (signal?.aborted) return done;
          const pruned = await stores.workflowRuns.pruneStepRunData({
            clientInstanceId,
            id,
            limit: stepBatch
          });
          if (pruned === 0) break;
          done.stepRuns += pruned;
          done.batches += 1;
        }
        // The run's files go with its values, before the run is marked.
        if (options.pruneRunFiles && !(await options.pruneRunFiles(id, signal))) return done;
        // Last, so a run whose step runs are not all done is found again.
        const marked = await stores.workflowRuns.markRunDataPruned({
          clientInstanceId,
          id,
          prunedAt: now().toISOString()
        });
        if (marked) done.runs += 1;
      }
    }
  }

  return {
    prune,
    schedule: defineSchedule({ kind: workflowPruneDataJobKind, every: DAY_MS, dueAtStart: true }),
    handler: defineJobHandler({
      kind: workflowPruneDataJobKind,
      slots: 1,
      async run(_job, control) {
        const done = await prune(control.signal);
        if (done.runs > 0) control.logger.info(done, "Removed the values of Workflow Runs");
      }
    })
  };
}
