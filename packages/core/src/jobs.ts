import { JOB_STATUSES } from "@work-shape/catalyst-asset-schemas";
import { AppError } from "./errors";
import type { Brand, ClientInstanceId } from "./ids";
import type { JsonObject } from "./json";
import type { StorePage } from "./paging";
import type { ISODateString } from "./time";

export type JobId = Brand<string, "JobId">;

/**
 * A job between attempts is `queued` with its attempts and last error. `dead` means the attempts
 * are used up. `failed` means the handler raised an error it marked as not retryable, or a
 * schedule tick failed. `cancelled` means the job was withdrawn: its subject was given up
 * before an attempt did its work. The executor has no waiting state: what waits, waits on its
 * own record and a wake enqueues a job.
 */
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The error class of a withdrawn job. It tells a job nobody ran from one that ran and ended. */
export const JOB_WITHDRAWN_ERROR_CODE = "WITHDRAWN";

/**
 * How long a job may be due before its caller asks whether any worker takes its kind. A worker
 * that is alive claims a due job at its next poll, a second later, when one of its slots is
 * free, so this only has to cover a worker that restarts. A caller that waits for such a job
 * is told that no worker takes it. Where the workers of a kind never reported, it is also the
 * window in which one must have claimed or ended a job to count as there.
 */
export const JOB_UNCLAIMED_MS = 30 * 1000;
/** How often a caller that still waits asks the queue whether a worker takes its job's kind. */
export const JOB_WORKER_CHECK_INTERVAL_MS = 5 * 1000;
/** How often a job worker reports that it serves its kinds. One statement per report. */
export const JOB_WORKER_REPORT_INTERVAL_MS = 10 * 1000;
/**
 * A kind whose workers reported nothing for this long has no worker: three reports are missed.
 * Instance > Infrastructure then shows what that worker checks as failed.
 */
export const JOB_WORKER_SILENT_MS = 3 * JOB_WORKER_REPORT_INTERVAL_MS;

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
  /**
   * How often the lease is renewed. Without it a third of the lease. A kind whose dead worker
   * must be noticed soon takes a short lease and names its heartbeat.
   */
  readonly heartbeatMs?: number;
  /** Limits on running jobs across the instance. A missing limit is no limit. */
  readonly concurrency: { readonly global?: number; readonly perKey?: number };
  /**
   * `false` when a person cannot retry an ended job of the kind, because running it again
   * would not redo its work. A schedule tick is such a job: the next tick is its retry.
   */
  readonly manualRetry?: false;
}

export function defineJobKind<Payload extends JsonObject>(
  definition: JobKind<Payload>
): JobKind<Payload> {
  const { kind, maxAttempts, backoff, leaseMs, heartbeatMs, concurrency } = definition;
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(kind))
    throw new AppError("VALIDATION_FAILED", `Job kind '${kind}' must be named <subject>.<verb>`);
  const positive = [maxAttempts, leaseMs, concurrency.global ?? 1, concurrency.perKey ?? 1];
  if (!positive.every((value) => Number.isInteger(value) && value > 0))
    throw new AppError(
      "VALIDATION_FAILED",
      `Job kind '${kind}' needs positive whole numbers for attempts, lease and concurrency`
    );
  if (
    heartbeatMs !== undefined &&
    !(Number.isInteger(heartbeatMs) && heartbeatMs > 0 && heartbeatMs < leaseMs)
  )
    throw new AppError(
      "VALIDATION_FAILED",
      `Job kind '${kind}' needs a heartbeat that is a positive whole number below its lease`
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

/**
 * The dedupe key of a job that drives one record: the kind and the record's id. While such a
 * job is queued or running, a second enqueue for the record inserts nothing.
 */
export function subjectDedupeKey(kind: string, subjectId: string): string {
  return `${kind}:${subjectId}`;
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
  /**
   * How many jobs of the kind under `concurrencyKey` run at once, for a bound that differs per
   * key: it takes the place of the kind's `concurrency.perKey`. The claim counts the running
   * jobs of the key against the limit of the job it would claim.
   */
  concurrencyLimit?: number;
  correlationId?: string;
}

export interface PruneEndedJobsResult {
  /** Succeeded and cancelled jobs removed. */
  completedCount: number;
  /** Failed and dead jobs removed. */
  failedCount: number;
}

/**
 * What an operator is shown of a job. It carries the class of the last error and never the
 * payload or an error message: a message can quote a provider or a record.
 */
export interface JobOverview {
  id: JobId;
  kind: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  /** The id of the record the job works on. */
  subject?: string;
  /** The class of the last error, such as `INTERNAL` or `LEASE_EXPIRED`. */
  errorCode?: string;
  createdAt: ISODateString;
  startedAt?: ISODateString;
  finishedAt?: ISODateString;
}

/** Which jobs a list asks for. Every filter that is set must hold. */
export interface JobListFilters {
  kind?: string;
  statuses?: readonly JobStatus[];
}

/** What one kind has waiting, running and ended in an error. */
export interface JobKindSummary {
  kind: string;
  queued: number;
  running: number;
  failed: number;
  dead: number;
  /** Since when the longest waiting queued job has been due. Missing when none is due. */
  waitingSince?: ISODateString;
}

/** What the queue shows of one kind and its workers, read in one statement. */
export interface JobKindActivity {
  /** Since when the longest waiting queued job has been due. Missing when none is due. */
  waitingSince?: ISODateString;
  /** Whether a job runs under a lease that is not over. A job a dead worker left does not count. */
  running: boolean;
  /** When a worker last claimed or ended a job. */
  takenAt?: ISODateString;
  /** The last report of the workers of the kind. Missing when none ever reported. */
  report?: JobWorkerReport;
}

/** The last report of the workers that serve a kind. */
export interface JobWorkerReport {
  kind: string;
  /** Since when the reports came without a gap of `JOB_WORKER_SILENT_MS`. */
  aliveSince: ISODateString;
  /** When a worker of the kind last reported. */
  seenAt: ISODateString;
}

export type RetryJobResult =
  | { outcome: "requeued"; job: JobOverview }
  | { outcome: "not_found" }
  /** Only a job that ended as `failed` or `dead` is retried. */
  | { outcome: "not_ended"; status: JobStatus }
  /** Another job of the kind is queued or running under the same dedupe key. */
  | { outcome: "superseded" };

export interface JobsStore {
  /**
   * Requests another execution no earlier than runAfter. Requests for one key coalesce
   * at the earliest requested time. Unlike enqueue, a running job cannot swallow this
   * wake: the executor queues it after that attempt ends. Commits with the subject row.
   */
  runAgainAfter<Payload extends JsonObject>(
    kind: JobKind<Payload>,
    payload: Payload,
    options: EnqueueJobOptions & { dedupeKey: string; runAfter: Date }
  ): Promise<void>;
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
   * Removes the queued job of a dedupe key. For a caller that did the job's work itself and
   * calls this in the transaction that finishes it. A job that an attempt has claimed stays;
   * that attempt finds nothing left to do.
   */
  withdraw(
    kind: JobKind,
    options: { clientInstanceId: ClientInstanceId; dedupeKey: string }
  ): Promise<void>;
  /** The last report of the workers that serve `kind`. Missing when none ever reported. */
  readWorkerReport(input: {
    clientInstanceId: ClientInstanceId;
    kind: string;
  }): Promise<JobWorkerReport | undefined>;
  /** What a caller that waits for a job of `kind` needs to tell whether a worker takes it. */
  readKindActivity(input: {
    clientInstanceId: ClientInstanceId;
    kind: string;
  }): Promise<JobKindActivity>;
  /**
   * Removes ended jobs: succeeded and cancelled ones 7 days after they ended, failed and dead
   * ones 30 days after. A dead job whose subject is still marked for deletion is kept.
   * The report of a kind whose workers have been gone for a day goes with them.
   */
  pruneEndedJobs(input: { clientInstanceId: ClientInstanceId }): Promise<PruneEndedJobsResult>;
  /** Per kind, the jobs that are queued, running, failed and dead. Kinds with none are left out. */
  summarizeByKind(input: { clientInstanceId: ClientInstanceId }): Promise<JobKindSummary[]>;
  /** Jobs as an operator sees them, newest first. */
  listOverview(input: {
    clientInstanceId: ClientInstanceId;
    filters?: JobListFilters;
    page?: StorePage;
  }): Promise<JobOverview[]>;
  /**
   * Queues a `failed` or `dead` job again, due at once, with its attempts reset. The last
   * error class stays on the row until the next attempt ends. Inside `stores.transaction` it
   * commits or rolls back with what the caller puts back on the subject record.
   */
  retry(input: { clientInstanceId: ClientInstanceId; id: string }): Promise<RetryJobResult>;
}

/** A handler throws this when another attempt cannot help. The job becomes `failed`. */
export class NonRetryableJobError extends AppError {
  constructor(message: string, details?: unknown) {
    super("CONFLICT", message, details);
    this.name = "NonRetryableJobError";
  }
}

/** A source asked the job to wait. Queue it durably without spending a failed attempt. */
export class JobDeferredError extends Error {
  constructor(readonly delayMs: number) {
    super("The source asked the job to wait");
    this.name = "JobDeferredError";
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("Invalid job delay");
  }
}

/**
 * A handler throws this when it finds its subject withdrawn: whoever queued the job cancelled
 * it before this attempt did any of its work. The job becomes `cancelled`, never `succeeded`.
 */
export class JobWithdrawnError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "JobWithdrawnError";
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

/**
 * Whether no worker takes the jobs of `kind` while one has been due for `unclaimedMs`. The
 * workers say so themselves: a kind whose last report is older than `JOB_WORKER_SILENT_MS` has
 * none, whatever its queue shows, and a kind that reports is waited for, however long its
 * workers are busy. A kind that never reported is served by a worker of the release before:
 * it has none when no job runs under a live lease and none was claimed or ended within
 * `unclaimedMs`. A job a dead worker left `running` is not a sign of a worker.
 */
export async function noWorkerTakesJobs(
  jobs: Pick<JobsStore, "readKindActivity">,
  input: { clientInstanceId: ClientInstanceId; kind: JobKind; unclaimedMs?: number }
): Promise<boolean> {
  const unclaimedMs = input.unclaimedMs ?? JOB_UNCLAIMED_MS;
  const activity = await jobs.readKindActivity({
    clientInstanceId: input.clientInstanceId,
    kind: input.kind.kind
  });
  const now = Date.now();
  if (activity.waitingSince === undefined || now - Date.parse(activity.waitingSince) < unclaimedMs)
    return false;
  if (activity.report) return now - Date.parse(activity.report.seenAt) > JOB_WORKER_SILENT_MS;
  if (activity.running) return false;
  return activity.takenAt === undefined || now - Date.parse(activity.takenAt) > unclaimedMs;
}
