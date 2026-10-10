import { describeWithoutMessage } from "../error-without-message";
import {
  AppError,
  JobLeaseLostError,
  NonRetryableJobError,
  createPlatformId,
  scheduleDedupeKey,
  toErrorEnvelope,
  type BoundJob,
  type ClientInstanceId,
  type JobControl,
  type JobId,
  type JobSchedule,
  type JobWorker,
  type Logger,
  type PlatformStores,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import {
  claimJobs,
  connectionOf,
  endJobAttempt,
  enqueueNextScheduleTick,
  ensureScheduleTick,
  heartbeatJob,
  listExhaustedJobIds,
  listKindsWithWork,
  lockExhaustedJob,
  lockLeasedJob,
  makeScheduleTickDue,
  mapJob,
  onJobsEnqueued,
  renewLockedJobLease,
  type JobEnding,
  type JobLease,
  type JobRow
} from "./store";

// The mechanics of the one loop. They are constants of the executor, not settings.
const POLL_INTERVAL_MS = 1_000;
const STOP_GRACE_MS = 20_000;
const SCHEDULE_CHECK_INTERVAL_MS = 60_000;
/**
 * The heartbeat sets the expiry to now plus the lease. It runs every third of the lease unless
 * the kind names its own interval.
 */
const HEARTBEATS_PER_LEASE = 3;

export interface CreatePostgresJobWorkerInput {
  /** Stores made by `createPostgresStores`. */
  stores: PlatformStores;
  clientInstanceId: ClientInstanceId;
  /** The kinds this process serves. */
  handlers: readonly RegisteredJobHandler[];
  /** Schedules of kinds this process serves. */
  schedules?: readonly JobSchedule[];
  logger: Logger;
}

interface ActiveJob {
  lease: JobLease;
  kind: string;
  abort: AbortController;
  stopHeartbeat(): void;
  ended: Promise<void>;
}

/** How an attempt ends. `exhausted` runs the handler's `onExhausted` in the same transaction. */
type Outcome = { type: "ended"; ending: JobEnding } | { type: "exhausted"; ending: JobEnding };

/** What one pass leaves running: the attempts it started. Each settles its own job. */
interface Pass {
  started: Promise<void>[];
}

export function createPostgresJobWorker(input: CreatePostgresJobWorkerInput): JobWorker {
  const { stores, clientInstanceId } = input;
  const workerId = createPlatformId("worker");
  const logger = input.logger.child({ component: "job-worker", workerId });
  const db = connectionOf(stores.jobs);
  const handlers = new Map(input.handlers.map((handler) => [handler.kind.kind, handler]));
  const schedules = new Map(
    (input.schedules ?? []).map((schedule) => [schedule.kind.kind, schedule])
  );
  if (handlers.size !== input.handlers.length)
    throw new AppError("VALIDATION_FAILED", "A job kind has more than one handler");
  for (const kind of schedules.keys()) {
    if (!handlers.has(kind))
      throw new AppError("VALIDATION_FAILED", `Schedule of '${kind}' has no handler here`);
  }

  const active = new Map<JobId, ActiveJob>();
  let stopping = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  /** A job was enqueued in this process since the last pass began. */
  let passRequested = false;
  let stopListening: (() => void) | undefined;
  let schedulesCheckedAt: number | undefined;
  let passing: Promise<void> = Promise.resolve();
  let passes = 0;
  let sleeping = false;
  const idleWaiters: Array<() => void> = [];

  /**
   * No pass and no job in flight, and a started worker asleep until its next poll. An enqueue
   * in this process ends the sleep at once, so the worker is not idle again before the pass
   * that the enqueue asked for.
   */
  const isIdle = () =>
    passes === 0 && active.size === 0 && (loop === undefined || sleeping || stopping);
  function noteIdle(): void {
    if (isIdle()) for (const resolve of idleWaiters.splice(0)) resolve();
  }

  const isTick = (row: JobRow) =>
    schedules.has(row.kind) && row.dedupeKey === scheduleDedupeKey(row.kind);

  /**
   * Ends an attempt in one transaction: the row is locked, the lease checked, the status
   * written and, for a tick, the next tick enqueued. Resolves false when the lease was lost.
   */
  async function settle(lease: JobLease, outcome: Outcome, bound?: BoundJob): Promise<boolean> {
    return stores.transaction(async (txStores) => {
      const tx = connectionOf(txStores.jobs);
      const row = await lockLeasedJob(tx, lease);
      if (!row) return false;
      if (outcome.type === "exhausted") await bound?.onExhausted?.(txStores);
      await endJobAttempt(tx, row.id, outcome.ending);
      await enqueueTickAfter(tx, row, outcome.ending);
      return true;
    });
  }

  async function enqueueTickAfter(
    tx: ReturnType<typeof connectionOf>,
    row: JobRow,
    ending: JobEnding
  ): Promise<void> {
    const schedule = schedules.get(row.kind);
    if (!schedule || !isTick(row) || ending.status === "released" || ending.status === "retry")
      return;
    await enqueueNextScheduleTick(tx, clientInstanceId, schedule);
  }

  function outcomeOfFailure(row: JobRow, handler: RegisteredJobHandler, error: unknown): Outcome {
    const { code, message } = toErrorEnvelope(error, row.correlationId).error;
    const failure = { errorCode: code, errorMessage: message };
    // A tick has one attempt and the next tick is its retry, so it fails and is never dead.
    if (error instanceof NonRetryableJobError || isTick(row))
      return { type: "ended", ending: { status: "failed", ...failure } };
    if (row.attempts < row.maxAttempts)
      return { type: "ended", ending: { status: "retry", kind: handler.kind, ...failure } };
    return { type: "exhausted", ending: { status: "dead", ...failure } };
  }

  /**
   * Settles and, when `onExhausted` itself fails, marks the job dead without it: its
   * transaction rolled back, and a job that cannot be buried would be found again at every poll.
   */
  async function settleOrBury(lease: JobLease, outcome: Outcome, bound?: BoundJob): Promise<void> {
    try {
      if (!(await settle(lease, outcome, bound)))
        logger.warn({ jobId: lease.jobId }, "Job lease was lost before the attempt ended");
    } catch (error) {
      if (outcome.type !== "exhausted") throw error;
      logger.error(
        { ...describeWithoutMessage(error), jobId: lease.jobId },
        "Job onExhausted failed"
      );
      await settle(lease, {
        type: "ended",
        ending: {
          status: "dead",
          errorCode: "EXHAUSTED_HANDLER_FAILED",
          errorMessage: "The last attempt failed and onExhausted failed after it"
        }
      });
    }
  }

  function run(handler: RegisteredJobHandler, row: JobRow): Promise<void> {
    const lease: JobLease = { jobId: row.id, token: row.leaseToken ?? "" };
    const jobLogger = logger.child({ jobId: row.id, kind: row.kind, attempt: row.attempts });
    const abort = new AbortController();
    let bound: BoundJob | undefined;
    // With `onHeartbeat` the lease and the handler's copy of it move in one transaction: a row
    // of the subject never shows a lease the job no longer has.
    const beat = (): Promise<boolean> => {
      const onHeartbeat = bound?.onHeartbeat;
      if (!onHeartbeat) return heartbeatJob(db, lease, handler.kind.leaseMs);
      return stores.transaction(async (txStores) => {
        const held = await heartbeatJob(connectionOf(txStores.jobs), lease, handler.kind.leaseMs);
        if (held) await onHeartbeat({ leaseToken: lease.token }, txStores);
        return held;
      });
    };
    const heartbeat = setInterval(
      () => {
        beat()
          .then((held) => {
            if (held) return;
            clearInterval(heartbeat);
            abort.abort(new JobLeaseLostError(row.id));
          })
          .catch((error: unknown) => {
            jobLogger.warn(describeWithoutMessage(error), "Job heartbeat failed");
          });
      },
      handler.kind.heartbeatMs ?? handler.kind.leaseMs / HEARTBEATS_PER_LEASE
    );
    const control: JobControl = {
      leaseToken: lease.token,
      signal: abort.signal,
      attempt: row.attempts,
      logger: jobLogger,
      transaction: (fn) =>
        stores.transaction(async (txStores) => {
          const tx = connectionOf(txStores.jobs);
          if (!(await lockLeasedJob(tx, lease))) throw new JobLeaseLostError(row.id);
          const result = await fn(txStores);
          // The heartbeat waits behind this transaction's lock on the row, so a transaction
          // longer than the lease would commit with a lease that looks expired and the job
          // would run again. The lease leaves the transaction renewed instead.
          await renewLockedJobLease(tx, lease, handler.kind.leaseMs);
          return result;
        })
    };
    const ended = (async () => {
      let outcome: Outcome;
      try {
        try {
          bound = handler.bind(mapJob(row));
        } catch {
          throw new NonRetryableJobError("The stored payload does not fit the job kind");
        }
        await bound.run(control);
        outcome = { type: "ended", ending: { status: "succeeded" } };
      } catch (error) {
        if (stopping) {
          // The worker asked the handler to stop; that is no failure of the job.
          outcome = { type: "ended", ending: { status: "released" } };
        } else {
          if (!(error instanceof JobLeaseLostError))
            jobLogger.error(describeWithoutMessage(error), "Job attempt failed");
          outcome = outcomeOfFailure(row, handler, error);
        }
      }
      clearInterval(heartbeat);
      await settleOrBury(lease, outcome, bound);
    })()
      .catch((error: unknown) => {
        jobLogger.error(
          describeWithoutMessage(error),
          "Job attempt could not be ended; its lease will expire"
        );
      })
      .finally(() => {
        clearInterval(heartbeat);
        active.delete(row.id);
        noteIdle();
      });
    active.set(row.id, {
      lease,
      kind: row.kind,
      abort,
      stopHeartbeat: () => clearInterval(heartbeat),
      ended
    });
    return ended;
  }

  /** Jobs whose lease expired on their last attempt: dead, with `onExhausted`, or a failed tick. */
  async function buryExhausted(handler: RegisteredJobHandler): Promise<void> {
    const kind = handler.kind.kind;
    for (const jobId of await listExhaustedJobIds(db, { clientInstanceId, kind })) {
      const bury = (withHandler: boolean) =>
        stores.transaction(async (txStores) => {
          const tx = connectionOf(txStores.jobs);
          const row = await lockExhaustedJob(tx, jobId);
          if (!row) return;
          const ending: JobEnding = {
            status: isTick(row) ? "failed" : "dead",
            errorCode: "LEASE_EXPIRED",
            errorMessage: "The lease expired without a heartbeat"
          };
          if (ending.status === "dead" && withHandler)
            await bindOrUndefined(handler, row)?.onExhausted?.(txStores);
          await endJobAttempt(tx, row.id, ending);
          await enqueueTickAfter(tx, row, ending);
        });
      try {
        await bury(true);
      } catch (error) {
        logger.error({ ...describeWithoutMessage(error), jobId }, "Job onExhausted failed");
        await bury(false);
      }
    }
  }

  async function ensureSchedules(): Promise<void> {
    const now = Date.now();
    if (schedulesCheckedAt !== undefined && now - schedulesCheckedAt < SCHEDULE_CHECK_INTERVAL_MS)
      return;
    for (const schedule of schedules.values()) {
      await ensureScheduleTick(db, clientInstanceId, schedule);
      if (schedule.dueAtStart && schedulesCheckedAt === undefined)
        await makeScheduleTickDue(db, clientInstanceId, schedule);
    }
    schedulesCheckedAt = now;
  }

  /** Passes of one worker run one after another, so each counts its free slots exactly. */
  function pass(): Promise<Pass> {
    passes += 1;
    const next = passing.then(onePass, onePass);
    const passed = () => {
      passes -= 1;
      noteIdle();
    };
    passing = next.then(passed, passed);
    return next;
  }

  /** One pass over the kinds served here. Returns the attempts it started. */
  async function onePass(): Promise<Pass> {
    const started: Promise<void>[] = [];
    if (stopping) return { started };
    await ensureSchedules();
    const withWork = await listKindsWithWork(db, { clientInstanceId, kinds: [...handlers.keys()] });
    for (const handler of handlers.values()) {
      const kind = handler.kind.kind;
      if (!withWork.has(kind)) continue;
      try {
        const running = [...active.values()].filter((job) => job.kind === kind).length;
        const rows = await claimJobs(db, {
          clientInstanceId,
          kind: handler.kind,
          workerId,
          limit: handler.slots - running
        });
        for (const row of rows) started.push(run(handler, row));
        await buryExhausted(handler);
      } catch (error) {
        logger.error({ ...describeWithoutMessage(error), kind }, "Job poll failed for a kind");
      }
    }
    if (stopping) await releaseActive();
    return { started };
  }

  /** Gives back what is still held: queued again, due at once, the attempt not counted. */
  async function releaseActive(): Promise<void> {
    for (const job of [...active.values()]) {
      job.stopHeartbeat();
      job.abort.abort(new AppError("CONFLICT", "The job worker is stopping"));
      try {
        await settle(job.lease, { type: "ended", ending: { status: "released" } });
      } catch (error) {
        logger.error(
          { ...describeWithoutMessage(error), jobId: job.lease.jobId },
          "Job could not be released"
        );
      }
    }
  }

  return {
    start() {
      if (loop || stopping) return;
      // A job enqueued in this process is claimed at once, not at the next second.
      stopListening = onJobsEnqueued(db, () => {
        passRequested = true;
        wake?.();
      });
      loop = (async () => {
        while (!stopping) {
          passRequested = false;
          try {
            await pass();
          } catch (error) {
            logger.error(describeWithoutMessage(error), "Job poll failed");
          }
          if (stopping) return;
          if (passRequested) continue;
          sleeping = true;
          noteIdle();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, POLL_INTERVAL_MS);
            timer.unref();
            wake = () => {
              // Not idle from here on: the pass this asks for has yet to run.
              sleeping = false;
              clearTimeout(timer);
              resolve();
            };
          });
          sleeping = false;
        }
      })();
    },
    async runDue() {
      await Promise.all((await pass()).started);
    },
    idle() {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    async stop() {
      stopping = true;
      stopListening?.();
      wake?.();
      await loop;
      await passing;
      for (const job of active.values())
        job.abort.abort(new AppError("CONFLICT", "The job worker is stopping"));
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...active.values()].map((job) => job.ended)),
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, STOP_GRACE_MS);
        })
      ]);
      clearTimeout(graceTimer);
      await releaseActive();
      noteIdle();
    }
  };
}

function bindOrUndefined(handler: RegisteredJobHandler, row: JobRow): BoundJob | undefined {
  try {
    return handler.bind(mapJob(row));
  } catch {
    return undefined;
  }
}
