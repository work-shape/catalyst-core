import { AppError } from "./errors";
import type { JsonObject } from "./json";
import type { Job, JobKind } from "./jobs";
import type { Logger } from "./logger";
import type { PlatformStores } from "./platform-store";

/** What the executor gives a handler for one attempt. */
export interface JobControl {
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
}

/** One claimed job with its payload validated, ready to run. */
export interface BoundJob {
  run(control: JobControl): Promise<void>;
  onExhausted?(stores: PlatformStores): Promise<void>;
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
      return {
        run: (control) => handler.run(typed, control),
        ...(onExhausted ? { onExhausted: (stores) => onExhausted(typed, stores) } : {})
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
   * Stops claiming, aborts every running handler's signal, waits up to 20 seconds for them to
   * return and releases what is left: such a job is queued again, due at once, with the attempt
   * given back.
   */
  stop(): Promise<void>;
}
