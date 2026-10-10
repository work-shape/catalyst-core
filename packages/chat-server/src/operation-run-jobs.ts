import {
  AppError,
  approvalExecutionOf,
  defineJobHandler,
  type ApprovalRequestStore,
  type ClientInstanceId,
  type JobSchedule,
  type Logger,
  type OperationRegistry,
  type OperationRun,
  type OperationRunStore,
  type PlatformStores,
  type RegisteredJobHandler,
  type UserStore
} from "@vivd-catalyst/core";
import {
  OPERATION_CALL_APPROVAL_KIND,
  readApprovedOperationEnd,
  type RunOperationDeps
} from "@vivd-catalyst/tool-execution";
import {
  APPROVED_OPERATION_CALL_SLOTS,
  executeApprovedOperationCallJob,
  expireOperationRunsJob,
  expireOperationRunsSchedule,
  recoverOperationRunsJob,
  recoverOperationRunsSchedule,
  removeEndedOperationCallInputJob,
  removeEndedOperationCallInputSchedule
} from "./job-kinds";
import {
  endedOperationCallOutcome,
  executeApprovedOperationCall,
  minimizedOperationCallPayload,
  recordApprovedOperationCallEnd
} from "./operation-call-approval-handler";

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

/**
 * How many ended requests one statement of the input cleanup reads, with their payload of at
 * most 256 KiB each, and how many statements one tick makes. A tick so clears at most 2,500
 * requests; the next one, six hours later or at the next start, takes the rest. Every path
 * that ends a request removes its input itself: the tick finds what a process that stopped in
 * between left, and the requests that ended before this was so.
 */
const ENDED_INPUT_CLEANUP_PAGE_SIZE = 25;
const ENDED_INPUT_CLEANUP_PAGES_PER_TICK = 100;

export interface OperationRunJobOptions {
  clientInstanceId: ClientInstanceId;
  runs: OperationRunStore;
  registry: OperationRegistry;
  /** Without it no call was ever held, and an expired run has no request to end. */
  approvals?: ApprovalRequestStore;
  /** The call path approved calls are executed on. Without it this process executes none. */
  calls?: { deps(): RunOperationDeps; users: Pick<UserStore, "getUser"> };
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
      // The request says that it expired, names nobody who decided it and loses its input.
      resolve: (pending) =>
        Promise.resolve(endedOperationCallOutcome(pending, { execution: "expired" }))
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

/**
 * Records an approved call whose job used up its attempts, in the transaction that marks the
 * job dead. A call that was never taken did not run and ends as failed; one that was taken and
 * not ended is interrupted. Either way the request says so and nothing runs it again.
 */
async function recordAbandonedOperationCall(
  options: OperationRunJobOptions,
  requestId: string,
  stores: PlatformStores
): Promise<void> {
  const { clientInstanceId } = options;
  const request = await stores.approvals.getApprovalRequest({ clientInstanceId, requestId });
  if (request?.status !== "approved" || approvalExecutionOf(request) !== "queued") {
    return;
  }
  const runId = typeof request.payload.runId === "string" ? request.payload.runId : "";
  const error = { code: "INTERNAL", message: "The approved call could not be started." };
  const run = await stores.operationRuns.get({ clientInstanceId, id: runId });
  const unstarted = run
    ? await stores.operationRuns.endWaiting({
        clientInstanceId,
        id: run.id,
        end: {
          status: "failed",
          finishedAt: options.now().toISOString(),
          error: { ...error, unexecuted: true }
        }
      })
    : undefined;
  await recordApprovedOperationCallEnd(
    { clientInstanceId, approvals: stores.approvals },
    requestId,
    unstarted
      ? { execution: "failed", run: unstarted, error }
      : await readApprovedOperationEnd(runId, { clientInstanceId, runs: stores.operationRuns })
  );
}

/**
 * Removes the input from the requests of held calls that have ended and still keep it. A
 * request whose approved call has not run yet keeps its input: the call is executed from it.
 */
async function removeEndedOperationCallInput(
  options: OperationRunJobOptions,
  approvals: ApprovalRequestStore,
  logger: Logger,
  signal?: AbortSignal
): Promise<number> {
  const { clientInstanceId } = options;
  let removed = 0;
  let after: readonly string[] | undefined;
  for (let page = 0; page < ENDED_INPUT_CLEANUP_PAGES_PER_TICK; page++) {
    if (signal?.aborted) break;
    const requests = await approvals.listApprovalRequests({
      clientInstanceId,
      kinds: [OPERATION_CALL_APPROVAL_KIND],
      excludeStatus: "pending",
      payloadKey: "input",
      page: { limit: ENDED_INPUT_CLEANUP_PAGE_SIZE, ...(after ? { after } : {}) }
    });
    for (const request of requests) {
      if (request.status === "approved" && approvalExecutionOf(request) === "queued") continue;
      const replaced = await approvals.replaceEndedApprovalRequestPayload({
        clientInstanceId,
        requestId: request.id,
        payload: minimizedOperationCallPayload(request.payload)
      });
      if (replaced) removed += 1;
    }
    const last = requests.at(-1);
    if (!last || requests.length < ENDED_INPUT_CLEANUP_PAGE_SIZE) break;
    after = [last.createdAt, last.id];
  }
  if (removed > 0) logger.info({ removed }, "Removed the input of ended operation call requests");
  return removed;
}

/**
 * The job kinds of Operation Runs: the two that keep runs from waiting or running for ever,
 * the one that executes an approved call, and the one that removes the input ended requests
 * still keep. The last two exist where this process holds calls for an approval.
 */
export function createOperationRunJobs(options: OperationRunJobOptions): {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
} {
  const { approvals, calls, clientInstanceId } = options;
  const held: { handlers: RegisteredJobHandler[]; schedules: JobSchedule[] } =
    approvals && calls
      ? {
          handlers: [
            defineJobHandler({
              kind: executeApprovedOperationCallJob,
              slots: APPROVED_OPERATION_CALL_SLOTS,
              async run(job, control) {
                await executeApprovedOperationCall(
                  { clientInstanceId, approvals, ...calls },
                  job.payload.requestId,
                  control.signal
                );
              },
              onExhausted: (job, stores) =>
                recordAbandonedOperationCall(options, job.payload.requestId, stores)
            }),
            defineJobHandler({
              kind: removeEndedOperationCallInputJob,
              slots: 1,
              async run(_job, control) {
                await removeEndedOperationCallInput(
                  options,
                  approvals,
                  control.logger,
                  control.signal
                );
              }
            })
          ],
          schedules: [removeEndedOperationCallInputSchedule]
        }
      : { handlers: [], schedules: [] };
  return {
    handlers: [
      ...held.handlers,
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
    schedules: [expireOperationRunsSchedule, recoverOperationRunsSchedule, ...held.schedules]
  };
}
