import { and, asc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import {
  AppError,
  createPlatformId,
  scheduleDedupeKey,
  type ClientInstanceId,
  type EnqueueJobOptions,
  type Job,
  type JobId,
  type JobKind,
  type JobSchedule,
  type JobsStore,
  type JsonObject,
  type PruneEndedJobsResult
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
import { platformJobs } from "../schema/jobs";

export type JobRow = typeof platformJobs.$inferSelect;

/** One attempt's hold on a job. A write is this attempt's only while the token still matches. */
export interface JobLease {
  jobId: JobId;
  token: string;
}

const COMPLETED_JOB_RETENTION_DAYS = 7;
const FAILED_JOB_RETENTION_DAYS = 30;
/** Failed onExhausted handlers and unreadable payloads are buried in batches of this size. */
const EXHAUSTED_BATCH_SIZE = 20;

const connections = new WeakMap<JobsStore, PostgresConnection>();

/**
 * The connection or transaction a jobs store is bound to. The worker reaches the executor's
 * queries through it, so they stay out of the store that the rest of the product sees.
 */
export function connectionOf(jobs: JobsStore): PostgresConnection {
  const connection = connections.get(jobs);
  if (!connection)
    throw new AppError("INTERNAL", "The job executor needs the stores of postgres-store");
  return connection;
}

const enqueueListeners = new WeakMap<PostgresConnection, Set<() => void>>();

/**
 * Calls `listener` after a job was enqueued through the stores of `connection` in this process
 * and its transaction committed. A worker uses it to poll at once instead of at its next
 * second. Returns the function that ends the subscription.
 */
export function onJobsEnqueued(connection: PostgresConnection, listener: () => void): () => void {
  const listeners = enqueueListeners.get(connection) ?? new Set();
  enqueueListeners.set(connection, listeners);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tells the workers of this process that the stores of `connection` committed a new job. */
export function notifyJobsEnqueued(connection: PostgresConnection): void {
  for (const listener of enqueueListeners.get(connection) ?? []) listener();
}

/** `enqueued` is called for every job this store inserts, before its transaction commits. */
export function createPostgresJobsStore(db: PostgresConnection, enqueued: () => void): JobsStore {
  const store: JobsStore = {
    async enqueue(kind, payload, options) {
      const job = await enqueueJob(db, kind, payload, options);
      enqueued();
      return job;
    },
    async withdraw(kind, options) {
      await db
        .delete(platformJobs)
        .where(
          and(
            eq(platformJobs.clientInstanceId, options.clientInstanceId),
            eq(platformJobs.kind, kind.kind),
            eq(platformJobs.dedupeKey, options.dedupeKey),
            eq(platformJobs.status, "queued")
          )
        );
    },
    pruneEndedJobs: (input) => pruneEndedJobs(db, input)
  };
  connections.set(store, db);
  return store;
}

export function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    kind: row.kind,
    ...(row.subject === null ? {} : { subject: row.subject }),
    payload: row.payload,
    status: row.status,
    runAfter: row.runAfter.toISOString(),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    ...(row.dedupeKey === null ? {} : { dedupeKey: row.dedupeKey }),
    ...(row.concurrencyKey === null ? {} : { concurrencyKey: row.concurrencyKey }),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    ...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() })
  };
}

/**
 * Inserts a job through `db`. A store that writes a subject record and its job in one
 * transaction of its own calls this with that transaction and reports the enqueue afterwards.
 */
export async function enqueueJob<Payload extends JsonObject>(
  db: PostgresConnection,
  kind: JobKind<Payload>,
  payload: Payload,
  options: EnqueueJobOptions & { delayMs?: number }
): Promise<Job<Payload>> {
  const validated = kind.payloadSchema.parse(payload);
  const live = and(
    eq(platformJobs.clientInstanceId, options.clientInstanceId),
    eq(platformJobs.kind, kind.kind),
    options.dedupeKey === undefined ? sql`false` : eq(platformJobs.dedupeKey, options.dedupeKey),
    inArray(platformJobs.status, ["queued", "running"])
  );
  // The live job of a dedupe key can end between the refused insert and the read of it, so the
  // pair is tried again. Each round needs another job to end at that exact moment.
  for (let round = 0; round < 5; round += 1) {
    const [inserted] = await db
      .insert(platformJobs)
      .values({
        id: createPlatformId<"JobId">("job"),
        clientInstanceId: options.clientInstanceId,
        kind: kind.kind,
        subject: options.subject ?? null,
        payload: validated,
        status: "queued",
        runAfter: options.runAfter ?? sql`now() + ${delay(options.delayMs ?? 0)}`,
        attempts: 0,
        maxAttempts: kind.maxAttempts,
        dedupeKey: options.dedupeKey ?? null,
        concurrencyKey: options.concurrencyKey ?? null,
        correlationId: options.correlationId ?? createPlatformId("corr"),
        createdAt: sql`now()`
      })
      .onConflictDoNothing({
        target: [platformJobs.clientInstanceId, platformJobs.kind, platformJobs.dedupeKey],
        where: sql`${platformJobs.dedupeKey} is not null and ${platformJobs.status} in ('queued', 'running')`
      })
      .returning();
    if (inserted) return { ...mapJob(inserted), payload: validated };
    const [existing] = await db.select().from(platformJobs).where(live).limit(1);
    if (existing)
      return { ...mapJob(existing), payload: kind.payloadSchema.parse(existing.payload) };
  }
  throw new AppError("CONFLICT", `Job of kind '${kind.kind}' could not be enqueued`);
}

async function pruneEndedJobs(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId }
): Promise<PruneEndedJobsResult> {
  const endedBefore = (statuses: JobRow["status"][], retentionDays: number) =>
    db
      .delete(platformJobs)
      .where(
        and(
          eq(platformJobs.clientInstanceId, input.clientInstanceId),
          inArray(platformJobs.status, statuses),
          lt(platformJobs.finishedAt, sql`now() - make_interval(days => ${retentionDays})`)
        )
      );
  const completed = await endedBefore(["succeeded", "cancelled"], COMPLETED_JOB_RETENTION_DAYS);
  const failed = await endedBefore(["failed", "dead"], FAILED_JOB_RETENTION_DAYS);
  return { completedCount: completed.count, failedCount: failed.count };
}

/** Makes sure the one live tick of a schedule exists. A tick that had to be made is due at once. */
export async function ensureScheduleTick(
  db: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  schedule: JobSchedule
): Promise<void> {
  await enqueueJob(
    db,
    schedule.kind,
    {},
    { clientInstanceId, dedupeKey: scheduleDedupeKey(schedule.kind.kind) }
  );
}

/** Makes the waiting tick of a schedule due now. A tick that runs is left alone. */
export async function makeScheduleTickDue(
  db: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  schedule: JobSchedule
): Promise<void> {
  await db
    .update(platformJobs)
    .set({ runAfter: sql`now()` })
    .where(
      and(
        eq(platformJobs.clientInstanceId, clientInstanceId),
        eq(platformJobs.kind, schedule.kind.kind),
        eq(platformJobs.dedupeKey, scheduleDedupeKey(schedule.kind.kind)),
        eq(platformJobs.status, "queued"),
        gt(platformJobs.runAfter, sql`now()`)
      )
    );
}

/** The next tick of a schedule, due `every` after now. Called in the transaction that ends one. */
export async function enqueueNextScheduleTick(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  schedule: JobSchedule
): Promise<void> {
  await enqueueJob(
    tx,
    schedule.kind,
    {},
    {
      clientInstanceId,
      dedupeKey: scheduleDedupeKey(schedule.kind.kind),
      delayMs: schedule.every
    }
  );
}

/** The kinds that have a due job or an expired lease. One read per poll decides who claims. */
export async function listKindsWithWork(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; kinds: readonly string[] }
): Promise<Set<string>> {
  if (input.kinds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ kind: platformJobs.kind })
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.clientInstanceId, input.clientInstanceId),
        inArray(platformJobs.kind, [...input.kinds]),
        sql`(
          (${platformJobs.status} = 'queued' and ${platformJobs.runAfter} <= now())
          or (${platformJobs.status} = 'running' and ${platformJobs.leaseExpiresAt} < now())
        )`
      )
    );
  return new Set(rows.map((row) => row.kind));
}

/**
 * Recovers the expired leases of a kind that have attempts left and claims up to `limit` due
 * jobs. Claims of one kind are serialized by an advisory lock held to the end of the
 * transaction, so the running counts read here are exact and both concurrency limits hold
 * across every worker of the instance.
 */
export async function claimJobs(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; kind: JobKind; workerId: string; limit: number }
): Promise<JobRow[]> {
  const { clientInstanceId, kind } = input;
  const ofKind = and(
    eq(platformJobs.clientInstanceId, clientInstanceId),
    eq(platformJobs.kind, kind.kind)
  );
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`platform_jobs:${clientInstanceId}:${kind.kind}`}, 0))`
    );
    // Recovery counts the attempt: the job waits out its backoff like after a failure.
    await tx
      .update(platformJobs)
      .set({
        status: "queued",
        runAfter: sql`now() + ${backoff(kind)}`,
        errorCode: "LEASE_EXPIRED",
        errorMessage: "The lease expired without a heartbeat",
        ...noLease
      })
      .where(
        and(
          ofKind,
          eq(platformJobs.status, "running"),
          lt(platformJobs.leaseExpiresAt, sql`now()`),
          lt(platformJobs.attempts, platformJobs.maxAttempts)
        )
      );
    let free = input.limit;
    if (kind.concurrency.global !== undefined) {
      const running = await tx.$count(
        platformJobs,
        and(ofKind, eq(platformJobs.status, "running"))
      );
      free = Math.min(free, kind.concurrency.global - running);
    }
    const claimed: JobRow[] = [];
    // One at a time, so each claim counts the ones before it against the limit per key.
    while (claimed.length < free) {
      const [candidate] = await tx
        .select({ id: platformJobs.id })
        .from(platformJobs)
        .where(
          and(
            ofKind,
            eq(platformJobs.status, "queued"),
            lte(platformJobs.runAfter, sql`now()`),
            kind.concurrency.perKey === undefined
              ? undefined
              : sql`(${platformJobs.concurrencyKey} is null or (
                  select count(*) from platform_jobs running
                  where running.client_instance_id = ${clientInstanceId}
                    and running.kind = ${kind.kind}
                    and running.status = 'running'
                    and running.concurrency_key = ${platformJobs.concurrencyKey}
                ) < ${kind.concurrency.perKey})`
          )
        )
        .orderBy(asc(platformJobs.runAfter), asc(platformJobs.createdAt), asc(platformJobs.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) break;
      const [row] = await tx
        .update(platformJobs)
        .set({
          status: "running",
          attempts: sql`${platformJobs.attempts} + 1`,
          leaseOwner: input.workerId,
          leaseToken: sql`gen_random_uuid()::text`,
          leaseExpiresAt: sql`now() + ${delay(kind.leaseMs)}`,
          heartbeatAt: sql`now()`,
          startedAt: sql`now()`
        })
        .where(eq(platformJobs.id, candidate.id))
        .returning();
      if (row) claimed.push(row);
    }
    return claimed;
  });
}

/**
 * Extends the lease. False when the lease is no longer this attempt's, which includes a lease
 * that ran out: an expired lease is never renewed, another worker may already count on it.
 * The times are the wall clock's, so a call inside a long transaction extends from now.
 */
export async function heartbeatJob(
  db: PostgresConnection,
  lease: JobLease,
  leaseMs: number
): Promise<boolean> {
  const rows = await db
    .update(platformJobs)
    .set({
      leaseExpiresAt: sql`clock_timestamp() + ${delay(leaseMs)}`,
      heartbeatAt: sql`clock_timestamp()`
    })
    .where(heldBy(lease))
    .returning({ id: platformJobs.id });
  return rows.length > 0;
}

/** Locks the job row for the transaction when this attempt still holds the lease. */
export async function lockLeasedJob(
  tx: PostgresConnection,
  lease: JobLease
): Promise<JobRow | undefined> {
  const [row] = await tx.select().from(platformJobs).where(heldBy(lease)).for("update");
  return row;
}

/**
 * Renews the lease of a row this transaction locked with `lockLeasedJob`. The lock kept every
 * other worker off the row since the lease was checked, so the lease is this attempt's even
 * when its time ran out meanwhile: the attempt's own heartbeat waits behind the same lock.
 */
export async function renewLockedJobLease(
  tx: PostgresConnection,
  lease: JobLease,
  leaseMs: number
): Promise<void> {
  await tx
    .update(platformJobs)
    .set({
      leaseExpiresAt: sql`clock_timestamp() + ${delay(leaseMs)}`,
      heartbeatAt: sql`clock_timestamp()`
    })
    .where(and(eq(platformJobs.id, lease.jobId), eq(platformJobs.leaseToken, lease.token)));
}

/** The running jobs of a kind whose lease expired on their last attempt. */
export async function listExhaustedJobIds(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; kind: string }
): Promise<JobId[]> {
  const rows = await db
    .select({ id: platformJobs.id })
    .from(platformJobs)
    .where(
      and(
        exhausted,
        eq(platformJobs.clientInstanceId, input.clientInstanceId),
        eq(platformJobs.kind, input.kind)
      )
    )
    .limit(EXHAUSTED_BATCH_SIZE);
  return rows.map((row) => row.id);
}

/** Locks a job whose lease expired on its last attempt, if that is still so. */
export async function lockExhaustedJob(
  tx: PostgresConnection,
  jobId: JobId
): Promise<JobRow | undefined> {
  const [row] = await tx
    .select()
    .from(platformJobs)
    .where(and(exhausted, eq(platformJobs.id, jobId)))
    .for("update");
  return row;
}

export type JobEnding =
  | { status: "succeeded" }
  | { status: "failed" | "dead"; errorCode: string; errorMessage: string }
  /** Another attempt after the kind's backoff. */
  | { status: "retry"; kind: JobKind; errorCode: string; errorMessage: string }
  /** Queued again, due at once, with the attempt given back. */
  | { status: "released" };

/** Ends an attempt on a row the transaction has locked. */
export async function endJobAttempt(
  tx: PostgresConnection,
  jobId: JobId,
  ending: JobEnding
): Promise<void> {
  const where = eq(platformJobs.id, jobId);
  switch (ending.status) {
    case "succeeded":
      await tx
        .update(platformJobs)
        .set({
          status: "succeeded",
          finishedAt: sql`now()`,
          errorCode: null,
          errorMessage: null,
          ...noLease
        })
        .where(where);
      return;
    case "failed":
    case "dead":
      await tx
        .update(platformJobs)
        .set({
          status: ending.status,
          finishedAt: sql`now()`,
          errorCode: ending.errorCode,
          errorMessage: ending.errorMessage,
          ...noLease
        })
        .where(where);
      return;
    case "retry":
      await tx
        .update(platformJobs)
        .set({
          status: "queued",
          runAfter: sql`now() + ${backoff(ending.kind)}`,
          errorCode: ending.errorCode,
          errorMessage: ending.errorMessage,
          ...noLease
        })
        .where(where);
      return;
    case "released":
      await tx
        .update(platformJobs)
        .set({
          status: "queued",
          runAfter: sql`now()`,
          attempts: sql`greatest(${platformJobs.attempts} - 1, 0)`,
          ...noLease
        })
        .where(where);
  }
}

const noLease = { leaseOwner: null, leaseToken: null, leaseExpiresAt: null } as const;

const exhausted = and(
  eq(platformJobs.status, "running"),
  lt(platformJobs.leaseExpiresAt, sql`now()`),
  sql`${platformJobs.attempts} >= ${platformJobs.maxAttempts}`
);

/** The lease is this attempt's and has not run out, by the database's clock. */
function heldBy(lease: JobLease) {
  return and(
    eq(platformJobs.id, lease.jobId),
    eq(platformJobs.leaseToken, lease.token),
    eq(platformJobs.status, "running"),
    gt(platformJobs.leaseExpiresAt, sql`clock_timestamp()`)
  );
}

function delay(milliseconds: number) {
  return sql`make_interval(secs => ${milliseconds}::double precision / 1000)`;
}

/** The wait before the next attempt: `baseMs` doubled per attempt already made, up to `maxMs`. */
function backoff(kind: JobKind) {
  return sql`make_interval(secs => least(
    ${kind.backoff.maxMs}::double precision,
    ${kind.backoff.baseMs}::double precision * power(2, greatest(${platformJobs.attempts} - 1, 0))
  ) / 1000)`;
}
