import {
  AppError,
  defineJobHandler,
  type ApprovalRequestStore,
  type ClientInstanceId,
  type JobSchedule,
  type Logger,
  type OperationRegistry,
  type OperationRun,
  type OperationRunStore,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import {
  expireOperationRunsJob,
  expireOperationRunsSchedule,
  recoverOperationRunsJob,
  recoverOperationRunsSchedule
} from "./job-kinds";

/**
 * How many waiting runs one statement of the expire job marks, and how many statements one
 * tick makes. A tick so ends at most 5,000 runs inside its lease; the next tick, five minutes
 * later, takes the rest. Each run is one more statement for its approval request.
 */
const OPERATION_RUN_EXPIRE_BATCH_SIZE = 500;
const OPERATION_RUN_EXPIRE_BATCHES_PER_TICK = 10;

/**
 * How many runs that are still `running` one tick of the recover job looks at, oldest first.
 * A run is looked at once it has run for the shortest time any operation may take, so in
 * normal operation the tick reads no row.
 */
const OPERATION_RUN_RECOVER_BATCH_SIZE = 500;

/**
 * The shortest time after which a `running` run is looked at at all. No operation names a
 * shorter time of its own than a minute.
 */
const OPERATION_RUN_RECOVER_MIN_AGE_MS = 60 * 1000;

/**
 * After how long a `running` run of an operation this process does not know counts as
 * interrupted: one that a release took away, or that a source no longer contributes.
 */
const UNKNOWN_OPERATION_TIMEOUT_MS = 60 * 60 * 1000;

export interface OperationRunJobOptions {
  clientInstanceId: ClientInstanceId;
  runs: OperationRunStore;
  registry: OperationRegistry;
  /** Without it no call was ever held, and an expired run has no request to end. */
  approvals?: Pick<ApprovalRequestStore, "transitionPendingApprovalRequest">;
  now(): Date;
}

/**
 * Ends the runs that waited for an approval longer than they may: the run is `expired`, its
 * approval request `superseded`, and nothing is executed. A request whose run expired and
 * that is still open, after a tick that was cut off between the two, is ended the same way
 * when somebody decides it.
 */
async function expireOperationRuns(
  options: OperationRunJobOptions,
  logger: Logger,
  signal?: AbortSignal
): Promise<number> {
  let expired = 0;
  for (let batch = 0; batch < OPERATION_RUN_EXPIRE_BATCHES_PER_TICK; batch++) {
    if (signal?.aborted) break;
    const runs = await options.runs.markExpired({
      clientInstanceId: options.clientInstanceId,
      limit: OPERATION_RUN_EXPIRE_BATCH_SIZE
    });
    for (const run of runs) {
      await supersedeRequestOf(options, run);
    }
    expired += runs.length;
    if (runs.length < OPERATION_RUN_EXPIRE_BATCH_SIZE) break;
  }
  if (expired > 0) logger.info({ expired }, "Expired operation runs that waited for an approval");
  return expired;
}

async function supersedeRequestOf(options: OperationRunJobOptions, run: OperationRun) {
  if (!options.approvals || run.approvalRequestId === undefined) {
    return;
  }
  try {
    await options.approvals.transitionPendingApprovalRequest({
      clientInstanceId: options.clientInstanceId,
      requestId: run.approvalRequestId,
      resolve: () => Promise.resolve({ status: "superseded" })
    });
  } catch (error) {
    // The request was decided or deleted meanwhile. Its run is expired either way.
    if (error instanceof AppError && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) {
      return;
    }
    throw error;
  }
}

/**
 * Fails the runs that have been `running` longer than their operation may take: the process
 * that ran them is gone. Such a run ends as `failed` with the code `interrupted`, and its
 * idempotency key never runs the call a second time.
 */
async function recoverOperationRuns(
  options: OperationRunJobOptions,
  logger: Logger
): Promise<number> {
  const now = options.now().getTime();
  const running = await options.runs.listRunningSince({
    clientInstanceId: options.clientInstanceId,
    startedBefore: new Date(now - OPERATION_RUN_RECOVER_MIN_AGE_MS).toISOString(),
    limit: OPERATION_RUN_RECOVER_BATCH_SIZE
  });
  let interrupted = 0;
  for (const run of running) {
    const definition = await options.registry.resolve(run.operation);
    const timeoutMs = definition?.timeoutMs ?? UNKNOWN_OPERATION_TIMEOUT_MS;
    const startedAt = new Date(run.startedAt ?? run.createdAt).getTime();
    if (now - startedAt <= timeoutMs) continue;
    const marked = await options.runs.markInterrupted({
      clientInstanceId: options.clientInstanceId,
      id: run.id
    });
    if (marked) interrupted += 1;
  }
  if (interrupted > 0) logger.warn({ interrupted }, "Failed operation runs that never ended");
  return interrupted;
}

/** The two job kinds that keep Operation Runs from waiting or running for ever. */
export function createOperationRunJobs(options: OperationRunJobOptions): {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
} {
  return {
    handlers: [
      defineJobHandler({
        kind: expireOperationRunsJob,
        slots: 1,
        async run(_job, control) {
          await expireOperationRuns(options, control.logger, control.signal);
        }
      }),
      defineJobHandler({
        kind: recoverOperationRunsJob,
        slots: 1,
        async run(_job, control) {
          await recoverOperationRuns(options, control.logger);
        }
      })
    ],
    schedules: [expireOperationRunsSchedule, recoverOperationRunsSchedule]
  };
}
