import { AppError } from "./errors";
import type { Brand, ClientInstanceId } from "./ids";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";

export type JobId = Brand<string, "JobId">;

/**
 * A job between attempts is `queued` with its attempts and last error. `dead` means the attempts
 * are used up. `failed` means the handler raised an error it marked as not retryable, or a
 * schedule tick failed. The executor has no waiting state: what waits, waits on its own record
 * and a wake enqueues a job.
 */
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead" | "cancelled";

/** What a kind needs of its payload schema. A Zod schema satisfies it. */
export interface JobPayloadSchema<Payload extends JsonObject> {
  parse(value: unknown): Payload;
}

/**
 * The declaration of a job kind. It holds no code, so a process that only enqueues a kind
 * imports the declaration without the handler another process serves.
 */
export interface JobKind<Payload extends JsonObject = JsonObject> {
  /** `<subject>.<verb>`. A kind is never renamed: queued rows carry the name. */
  readonly kind: string;
  /** References only, never content. */
  readonly payloadSchema: JobPayloadSchema<Payload>;
  readonly maxAttempts: number;
  /** The wait before attempt n+1 doubles per attempt from `baseMs` up to `maxMs`. */
  readonly backoff: { readonly baseMs: number; readonly maxMs: number };
  /** A running job whose lease is this old without a heartbeat is recovered. */
  readonly leaseMs: number;
  /** Limits on running jobs across the instance. A missing limit is no limit. */
  readonly concurrency: { readonly global?: number; readonly perKey?: number };
}

export function defineJobKind<Payload extends JsonObject>(
  definition: JobKind<Payload>
): JobKind<Payload> {
  const { kind, maxAttempts, backoff, leaseMs, concurrency } = definition;
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(kind))
    throw new AppError("VALIDATION_FAILED", `Job kind '${kind}' must be named <subject>.<verb>`);
  const positive = [maxAttempts, leaseMs, concurrency.global ?? 1, concurrency.perKey ?? 1];
  if (!positive.every((value) => Number.isInteger(value) && value > 0))
    throw new AppError(
      "VALIDATION_FAILED",
      `Job kind '${kind}' needs positive whole numbers for attempts, lease and concurrency`
    );
  if (!(backoff.baseMs >= 0 && backoff.maxMs >= backoff.baseMs))
    throw new AppError("VALIDATION_FAILED", `Job kind '${kind}' has an invalid backoff`);
  return Object.freeze({
    ...definition,
    backoff: Object.freeze({ ...backoff }),
    concurrency: Object.freeze({ ...concurrency })
  });
}

/** The payload of a kind that a schedule runs: a tick carries nothing. */
export type ScheduledJobPayload = Record<string, never>;

/**
 * Runs a kind again and again. One tick exists at a time; when it ends, in success or failure,
 * the next is due `every` milliseconds after that end. A tick has one attempt, because the next
 * tick is the retry.
 */
export interface JobSchedule {
  readonly kind: JobKind<ScheduledJobPayload>;
  /** Milliseconds between the end of one tick and the start of the next. */
  readonly every: number;
  /**
   * A worker that starts makes the waiting tick due at once, whatever is left of its interval.
   * For a kind that repairs what the last process left behind.
   */
  readonly dueAtStart?: boolean;
}

export function defineSchedule(schedule: JobSchedule): JobSchedule {
  if (!(Number.isInteger(schedule.every) && schedule.every > 0))
    throw new AppError(
      "VALIDATION_FAILED",
      `Schedule of '${schedule.kind.kind}' needs a positive interval`
    );
  if (schedule.kind.maxAttempts !== 1)
    throw new AppError(
      "VALIDATION_FAILED",
      `Scheduled kind '${schedule.kind.kind}' has one attempt; the next tick is the retry`
    );
  return Object.freeze({ ...schedule });
}

/** The dedupe key under which the one live tick of a scheduled kind is held. */
export function scheduleDedupeKey(kind: string): string {
  return `schedule:${kind}`;
}

export interface Job<Payload extends JsonObject = JsonObject> {
  id: JobId;
  clientInstanceId: ClientInstanceId;
  kind: string;
  /** The id of the record the job works on. */
  subject?: string;
  payload: Payload;
  status: JobStatus;
  runAfter: ISODateString;
  /** Attempts started so far, the running one included. */
  attempts: number;
  maxAttempts: number;
  dedupeKey?: string;
  concurrencyKey?: string;
  /** The last error, kept while the job waits for its next attempt and after it ended. */
  errorCode?: string;
  errorMessage?: string;
  correlationId: string;
  createdAt: ISODateString;
  startedAt?: ISODateString;
  finishedAt?: ISODateString;
}

export interface EnqueueJobOptions {
  clientInstanceId: ClientInstanceId;
  subject?: string;
  /** Not before this moment. Missing means at once. */
  runAfter?: Date;
  /**
   * While a queued or running job of the kind holds this key, enqueueing returns that job and
   * inserts nothing.
   */
  dedupeKey?: string;
  /** The key the kind's `concurrency.perKey` counts by. */
  concurrencyKey?: string;
  correlationId?: string;
}

export interface PruneEndedJobsResult {
  /** Succeeded and cancelled jobs removed. */
  completedCount: number;
  /** Failed and dead jobs removed. */
  failedCount: number;
}

export interface JobsStore {
  /**
   * Enqueues a job. Inside `stores.transaction` it commits or rolls back with the subject
   * record. The payload is validated here and again when the job is claimed.
   */
  enqueue<Payload extends JsonObject>(
    kind: JobKind<Payload>,
    payload: Payload,
    options: EnqueueJobOptions
  ): Promise<Job<Payload>>;
  /**
   * Removes ended jobs: succeeded and cancelled ones 7 days after they ended, failed and dead
   * ones 30 days after.
   */
  pruneEndedJobs(input: { clientInstanceId: ClientInstanceId }): Promise<PruneEndedJobsResult>;
}

/** A handler throws this when another attempt cannot help. The job becomes `failed`. */
export class NonRetryableJobError extends AppError {
  constructor(message: string, details?: unknown) {
    super("CONFLICT", message, details);
    this.name = "NonRetryableJobError";
  }
}

/** Thrown by `control.transaction` when the job's lease is no longer this attempt's. */
export class JobLeaseLostError extends AppError {
  constructor(jobId: JobId) {
    super("CONFLICT", `Job ${jobId} is no longer leased to this attempt`);
    this.name = "JobLeaseLostError";
  }
}

/** The schema of a tick: an empty object. */
export const scheduledJobPayloadSchema: JobPayloadSchema<ScheduledJobPayload> = {
  parse(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length > 0
    )
      throw new AppError("VALIDATION_FAILED", "A schedule tick carries no payload");
    return {};
  }
};
