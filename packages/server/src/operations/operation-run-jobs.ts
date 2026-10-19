import { z } from "zod";
import {
  AppError,
  WAITING_OPERATION_RUN_STATUSES,
  approvalExecutionOf,
  asUserId,
  defineJobHandler,
  type ApprovalRequest,
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
} from "@work-shape/catalyst-core";
import {
  readDecidedOperationEnd,
  refuseWaitingOperation,
  type RunOperationDeps
} from "@work-shape/catalyst-tool-execution";
import {
  APPROVED_OPERATION_CALL_SLOTS,
  executeApprovedOperationCallJob,
  expireOperationRunsJob,
  expireOperationRunsSchedule,
  recoverOperationRunsJob,
  recoverOperationRunsSchedule,
  removeEndedOperationCallInputJob,
  removeEndedOperationCallInputSchedule
} from "../jobs/job-kinds";
import {
  HELD_CALL_APPROVAL_KINDS,
  endedOperationCallOutcome,
  executeApprovedOperationCall,
  minimizedOperationCallPayload,
  recordApprovedOperationCallEnd
} from "../approvals/operation-call-approval-handler";

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

const pagedProgressSchema = z.object({
  deadlineAt: z.iso.datetime(),
  recoverAfter: z.iso.datetime()
});

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
 * Ends calls whose confirmation or approval deadline passed. The store atomically records
 * expiry and queues any waiting Agent Run with its expired result; nothing executes here.
 * An approval request is superseded. A request whose run expired and
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
  if (expired > 0) logger.info({ expired }, "Expired operation runs that waited for a decision");
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
    const parsed = pagedProgressSchema.safeParse(run.output?.value);
    const progress =
      run.origin.kind === "workflow" && run.effect === "reading" && parsed.success
        ? parsed.data
        : undefined;
    // A paged read is one run for many calls. Its checkpoint bounds both its total
    // duration and a stalled worker; a source deferral can extend only the latter.
    const recoverAt = progress
      ? Math.min(Date.parse(progress.deadlineAt), Date.parse(progress.recoverAfter))
      : startedAt + timeoutMs;
    if (now <= recoverAt) continue;
    const marked = await options.runs.markInterrupted({
      clientInstanceId: options.clientInstanceId,
      id: run.id,
      ...(progress ? { recoverAfter: progress.recoverAfter } : {})
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
  // A run whose confirmation moved it to wait for an approver waits on that other request now:
  // this one says so, and the run is left to it.
  const ownsRun = run !== undefined && (run.approvalRequestId ?? requestId) === requestId;
  const unstarted = ownsRun
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
      : await readDecidedOperationEnd(runId, requestId, {
          clientInstanceId,
          runs: stores.operationRuns
        })
  );
}

/**
 * Removes the input from the requests of held calls that have ended and still keep it. A
 * request whose approved call has not run yet keeps its input: the call is executed from it.
 *
 * A request that is still open, or approved and not executed, is ended here where its call
 * can never run: the run no longer exists, because its conversation was deleted while
 * somebody decided on the request, its run already ended, or its requester is gone. This
 * also repairs expiry ticks cut off before their request settlement.
 */
export async function removeEndedOperationCallInput(
  options: OperationRunJobOptions,
  approvals: ApprovalRequestStore,
  logger: Logger,
  signal?: AbortSignal,
  endedRunsOnly = false
): Promise<number> {
  const { clientInstanceId } = options;
  let removed = 0;
  let after: readonly string[] | undefined;
  for (let page = 0; page < ENDED_INPUT_CLEANUP_PAGES_PER_TICK; page++) {
    if (signal?.aborted) break;
    const requests = await approvals.listApprovalRequests({
      clientInstanceId,
      kinds: HELD_CALL_APPROVAL_KINDS,
      payloadKey: "input",
      ...(endedRunsOnly ? { endedRunOnly: true as const } : {}),
      page: { limit: ENDED_INPUT_CLEANUP_PAGE_SIZE, ...(after ? { after } : {}) }
    });
    for (const request of requests) {
      const queued = request.status === "approved" && approvalExecutionOf(request) === "queued";
      if (request.status === "pending" || queued) {
        if (await endOrphanedOperationCall(options, approvals, request)) removed += 1;
        continue;
      }
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

const RUN_GONE = { code: "NOT_FOUND", message: "The call of this request no longer exists." };
const REQUESTER_GONE = {
  code: "FORBIDDEN",
  message: "The account of the person who made this call was deleted."
};

/**
 * Ends a request that still keeps its call when that call can never run, and removes its
 * input. Answers whether it did. A request somebody decides at this moment is left to the
 * next tick.
 */
async function endOrphanedOperationCall(
  options: OperationRunJobOptions,
  approvals: ApprovalRequestStore,
  request: ApprovalRequest
): Promise<boolean> {
  const { clientInstanceId } = options;
  const runId = typeof request.payload.runId === "string" ? request.payload.runId : "";
  const run = await options.runs.get({ clientInstanceId, id: runId });
  const requester =
    run && options.calls
      ? await options.calls.users.getUser({
          clientInstanceId,
          userId: asUserId(request.requestedBy.id)
        })
      : undefined;
  const requesterGone =
    run !== undefined &&
    options.calls !== undefined &&
    (requester === undefined || requester.status === "deleting");
  const runEnded =
    run !== undefined &&
    run.status !== "running" &&
    !WAITING_OPERATION_RUN_STATUSES.some((status) => status === run.status);
  if (run && !runEnded && !requesterGone) return false;
  if (request.status === "approved") {
    // The job of an approved call refuses a requester who is gone itself.
    if (run) return false;
    await recordApprovedOperationCallEnd({ clientInstanceId, approvals }, request.id, {
      execution: "refused",
      error: RUN_GONE
    });
    return true;
  }
  try {
    await approvals.transitionPendingApprovalRequest({
      clientInstanceId,
      requestId: request.id,
      resolve: async (pending, stores) => {
        const waiting = await stores.operationRuns.get({ clientInstanceId, id: runId });
        if (
          waiting &&
          waiting.status !== "running" &&
          !WAITING_OPERATION_RUN_STATUSES.some((status) => status === waiting.status)
        ) {
          return endedOperationCallOutcome(pending, {
            execution: waiting.status === "expired" ? "expired" : "refused",
            ...(waiting.error ? { error: waiting.error } : {})
          });
        }
        if (waiting) {
          await refuseWaitingOperation(
            waiting.id,
            { kind: "forbidden", action: "operations.call", reason: "holder_inactive" },
            { clientInstanceId, runs: stores.operationRuns, now: options.now }
          );
        }
        return endedOperationCallOutcome(pending, {
          execution: "refused",
          error: waiting ? REQUESTER_GONE : RUN_GONE
        });
      }
    });
    return true;
  } catch (error) {
    if (error instanceof AppError && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) {
      return false;
    }
    throw error;
  }
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
