import { AppError } from "./errors";
import type { ClientInstanceId } from "./ids";
import type { JsonObject } from "./json";
import type { Job, JobKind } from "./jobs";
import type { Logger } from "./logger";
import type { SubjectRowClaim } from "./files";
import type { JobId } from "./jobs";
import type { PlatformStores } from "./platform-store";

// How often a job looks again at a subject row that a worker of the previous release holds.
// The row's work starts at most this long after that worker finished or its lease ran out.
export const SUBJECT_ROW_YIELD_CHECK_INTERVAL_MS = 5_000;

/** What the executor gives a handler for one attempt. */
export interface JobControl {
  /** The lease token of this attempt. A handler that mirrors its lease writes this token. */
  readonly leaseToken: string;
  /** Aborted when the lease is lost or the worker stops. */
  readonly signal: AbortSignal;
  /** The number of this attempt, starting at 1. */
  readonly attempt: number;
  readonly logger: Logger;
  /**
   * Opens `stores.transaction`, locks the job row and checks that this attempt still holds the
   * lease, then runs `fn`. It throws `JobLeaseLostError` when the lease is lost. Every write a
   * handler makes to a subject record goes through it, so an attempt that was taken over
   * changes nothing.
   */
  transaction<Result>(fn: (stores: PlatformStores) => Promise<Result>): Promise<Result>;
}

/** The code a serving process gives its worker for one kind. */
export interface JobHandler<Payload extends JsonObject = JsonObject> {
  readonly kind: JobKind<Payload>;
  /** How many jobs of the kind this process runs at once. */
  readonly slots: number;
  run(job: Job<Payload>, control: JobControl): Promise<void>;
  /**
   * Runs when the last attempt is used up, in the transaction that marks the job `dead`.
   * `stores` are bound to that transaction.
   */
  onExhausted?(job: Job<Payload>, stores: PlatformStores): Promise<void>;
  /**
   * Runs in the transaction of every heartbeat that extended the lease, with `leaseToken` the
   * token of this attempt. `stores` are bound to that transaction.
   *
   * Transition release only: the two kinds that moved onto the executor copy their lease onto
   * the lease columns of their subject row with it, so a worker of the previous release sees
   * the row as held. It goes with those columns in the contract step.
   */
  onHeartbeat?(job: Job<Payload>, lease: JobLeaseMirror, stores: PlatformStores): Promise<void>;
}

/** The lease of the running attempt, as a handler copies it onto a subject row. */
export interface JobLeaseMirror {
  /** The lease token of this attempt. It changes with every attempt. */
  readonly leaseToken: string;
}

/** One claimed job with its payload validated, ready to run. */
export interface BoundJob {
  run(control: JobControl): Promise<void>;
  onExhausted?(stores: PlatformStores): Promise<void>;
  onHeartbeat?(lease: JobLeaseMirror, stores: PlatformStores): Promise<void>;
}

/** A handler as a worker holds it, whatever its payload type. */
export interface RegisteredJobHandler {
  readonly kind: JobKind;
  readonly slots: number;
  /** Validates the stored payload against the kind's schema. Throws when it does not fit. */
  bind(job: Job): BoundJob;
}

/**
 * Registers a handler for a worker. The payload a claimed job carries is validated here, so
 * `run` receives the type its kind declares.
 */
export function defineJobHandler<Payload extends JsonObject>(
  handler: JobHandler<Payload>
): RegisteredJobHandler {
  if (!(Number.isInteger(handler.slots) && handler.slots > 0))
    throw new AppError("VALIDATION_FAILED", `Handler of '${handler.kind.kind}' needs slots`);
  return {
    kind: handler.kind,
    slots: handler.slots,
    bind(job) {
      const typed: Job<Payload> = {
        ...job,
        payload: handler.kind.payloadSchema.parse(job.payload)
      };
      const onExhausted = handler.onExhausted?.bind(handler);
      const onHeartbeat = handler.onHeartbeat?.bind(handler);
      return {
        run: (control) => handler.run(typed, control),
        ...(onExhausted ? { onExhausted: (stores) => onExhausted(typed, stores) } : {}),
        ...(onHeartbeat
          ? { onHeartbeat: (lease, stores) => onHeartbeat(typed, lease, stores) }
          : {})
      };
    }
  };
}

export interface JobWorker {
  /** Makes sure every schedule has its tick, then polls once a second until `stop`. */
  start(): void;
  /**
   * One pass now: recovers expired leases, claims what is due and resolves when the jobs this
   * pass started have ended. Tests and one-off runs drive the worker with it.
   */
  runDue(): Promise<void>;
  /**
   * Resolves when the worker has nothing in flight: no pass and no job running, and a started
   * worker asleep until its next poll. An enqueue in this process ends that sleep at once, so
   * a caller that must see the effect of what it enqueued waits on this instead of on time.
   */
  idle(): Promise<void>;
  /**
   * Stops claiming, aborts every running handler's signal, waits up to 20 seconds for them to
   * return and releases what is left: such a job is queued again, due at once, with the attempt
   * given back.
   *
   * With `drainMs` the running jobs first get that long to end on their own, their leases
   * renewed as before; only then are the handlers that are left aborted. A second call ends
   * the drain at once.
   */
  stop(options?: JobWorkerStopOptions): Promise<void>;
}

export interface JobWorkerStopOptions {
  /** How long running jobs may go on before their handlers are aborted. Missing means not at all. */
  drainMs?: number;
}

/** The owner a job writes onto the lease columns of its subject row. */
export function subjectRowLeaseOwnerId(jobId: JobId): string {
  return `job:${jobId}`;
}

/**
 * Transition release only: a handler's first step, the claim of its subject row by id.
 * Resolves with the row once it is this attempt's and with `undefined` when the row is
 * finished and the job has nothing to do. While a worker of the previous release holds the
 * row under a live lease it waits, looking again every five seconds, until that worker
 * finished the row or its lease ran out. The executor keeps this job's own lease alive
 * meanwhile. Rejects when the lease is lost or the worker stops.
 */
export async function claimSubjectRow<Row>(
  control: JobControl,
  claim: (stores: PlatformStores) => Promise<SubjectRowClaim<Row>>,
  checkIntervalMs = SUBJECT_ROW_YIELD_CHECK_INTERVAL_MS
): Promise<Row | undefined> {
  for (;;) {
    const result = await control.transaction(claim);
    if (result.status === "claimed") return result.row;
    if (result.status === "finished") return undefined;
    await waitOrAbort(checkIntervalMs, control.signal);
  }
}

function waitOrAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortReason = (): unknown =>
      signal.reason ?? new AppError("CONFLICT", "The job attempt was stopped");
    if (signal.aborted) {
      reject(abortReason());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The job a person retries, as the code that puts its subject back sees it. */
export interface RetriedJob {
  readonly clientInstanceId: ClientInstanceId;
  readonly kind: string;
  /** The id of the record the job works on. */
  readonly subject?: string;
}

/**
 * What the API needs to retry an ended job of a kind by hand. A kind without one is not
 * retried: the API cannot know what its job left behind.
 */
export interface JobRetry {
  readonly kind: JobKind;
  /**
   * Puts the subject record back into the state the job works from, in the transaction that
   * queues the job again. A job that gave up has usually marked its subject as failed, and a
   * job that finds its subject finished does nothing. Answers false when the record cannot be
   * worked on again; the retry is then refused and nothing changes. Missing when the job
   * reads everything it needs anew.
   */
  restoreSubject?(job: RetriedJob, stores: PlatformStores): Promise<boolean>;
}
