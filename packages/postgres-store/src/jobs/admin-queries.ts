import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  AppError,
  type ClientInstanceId,
  type JobKindSummary,
  type JobOverview,
  type JobsStore,
  type JobStatus,
  type RetryJobResult
} from "@vivd-catalyst/core";
import { keysetFilter } from "../paging";
import type { PostgresConnection } from "../postgres-database";
import { platformJobs } from "../schema/jobs";

type Input<Method extends keyof JobsStore> = Parameters<JobsStore[Method]>[0];

/** The statuses an operator watches: what waits, what runs and what ended in an error. */
const SUMMARIZED_STATUSES = ["queued", "running", "failed", "dead"] as const;
const RETRYABLE_STATUSES = ["failed", "dead"] as const satisfies readonly JobStatus[];

/**
 * What an operator is shown of a row. The payload and the error message are not selected, so
 * neither can reach an answer by a mapping mistake.
 */
const overviewColumns = {
  id: platformJobs.id,
  kind: platformJobs.kind,
  status: platformJobs.status,
  attempts: platformJobs.attempts,
  maxAttempts: platformJobs.maxAttempts,
  subject: platformJobs.subject,
  errorCode: platformJobs.errorCode,
  createdAt: platformJobs.createdAt,
  startedAt: platformJobs.startedAt,
  finishedAt: platformJobs.finishedAt
};

interface OverviewRow {
  id: JobOverview["id"];
  kind: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  subject: string | null;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

function mapOverview(row: OverviewRow): JobOverview {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    ...(row.subject === null ? {} : { subject: row.subject }),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() })
  };
}

/**
 * Counts per kind and status from `platform_jobs_claim_idx` alone. The kinds are read by
 * stepping through the index from one kind to the next, and each count reads only the index
 * entries of its kind and status. The work grows with the jobs that are counted and not with
 * the succeeded jobs beside them, which are most of the table.
 */
export async function summarizeJobsByKind(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId }
): Promise<JobKindSummary[]> {
  const ofInstance = sql`client_instance_id = ${input.clientInstanceId}`;
  const rows = await db.execute(sql`
with recursive kinds as (
  (select kind from platform_jobs where ${ofInstance} order by kind limit 1)
  union all
  select (
    select next.kind from platform_jobs next
    where next.${ofInstance} and next.kind > kinds.kind order by next.kind limit 1
  )
  from kinds where kinds.kind is not null
)
select kinds.kind, watched.status, counted.count, counted.waiting_since_ms
from kinds
cross join unnest(${sql.param([...SUMMARIZED_STATUSES])}::text[]) as watched(status)
cross join lateral (
  select
    count(*)::int as count,
    (extract(epoch from min(job.run_after) filter (
      where job.status = 'queued' and job.run_after <= now()
    )) * 1000)::float8 as waiting_since_ms
  from platform_jobs job
  where job.${ofInstance} and job.kind = kinds.kind and job.status = watched.status
) counted
where kinds.kind is not null and counted.count > 0
order by kinds.kind`);

  const byKind = new Map<string, JobKindSummary>();
  for (const row of rows) {
    const { kind, status, count, waiting_since_ms: waitingSinceMs } = row;
    const watched = SUMMARIZED_STATUSES.find((candidate) => candidate === status);
    if (typeof kind !== "string" || typeof count !== "number" || !watched)
      throw new AppError("INTERNAL", "The job summary answered an unreadable row");
    const summary = byKind.get(kind) ?? { kind, queued: 0, running: 0, failed: 0, dead: 0 };
    byKind.set(kind, summary);
    summary[watched] = count;
    if (typeof waitingSinceMs === "number")
      summary.waitingSince = new Date(Math.round(waitingSinceMs)).toISOString();
  }
  return [...byKind.values()];
}

// A list answers its times in milliseconds and the next page starts after the last one
// answered. The row holds microseconds, so order and page are cut on the millisecond too:
// otherwise a job created in the same millisecond as the last one shown would be skipped.
const createdAtMillisecond = sql`date_trunc('milliseconds', ${platformJobs.createdAt})`;

/**
 * True for every row of the instance. It names the kinds, read by stepping through
 * `platform_jobs_claim_idx`, so that a list by status alone reads that index by kind and
 * status and not the whole table: the index starts with the kind.
 */
function kindIsOneOfInstance(clientInstanceId: ClientInstanceId) {
  const ofInstance = sql`client_instance_id = ${clientInstanceId}`;
  return sql`${platformJobs.kind} = any(array(
with recursive k as (
  (select kind from platform_jobs where ${ofInstance} order by kind limit 1)
  union all
  select (
    select n.kind from platform_jobs n where n.${ofInstance} and n.kind > k.kind
    order by n.kind limit 1
  )
  from k where k.kind is not null
)
select kind from k where kind is not null))`;
}

/**
 * Newest first. A list by status, with or without a kind, reads `platform_jobs_claim_idx`
 * and sorts what it found, so its work grows with the jobs in those statuses. A list without
 * a status reads every job of the instance or of the kind.
 */
export async function listJobOverview(
  db: PostgresConnection,
  input: Input<"listOverview">
): Promise<JobOverview[]> {
  const { filters = {} } = input;
  const rows = await db
    .select(overviewColumns)
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.clientInstanceId, input.clientInstanceId),
        filters.kind === undefined
          ? filters.statuses && kindIsOneOfInstance(input.clientInstanceId)
          : eq(platformJobs.kind, filters.kind),
        filters.statuses === undefined
          ? undefined
          : inArray(platformJobs.status, [...filters.statuses]),
        keysetFilter(input.page, [createdAtMillisecond, platformJobs.id], true)
      )
    )
    .orderBy(desc(createdAtMillisecond), desc(platformJobs.id))
    .limit(input.page?.limit ?? 2147483647);
  return rows.map(mapOverview);
}

/**
 * Queues an ended job again in one statement. A job whose dedupe key another queued or running
 * job of the kind holds is left alone: the newer job already does its work, and the index
 * that allows one live job per key is what refuses the second.
 */
export async function retryJob(
  db: PostgresConnection,
  input: Input<"retry">
): Promise<RetryJobResult> {
  const ofInstance = and(
    eq(platformJobs.clientInstanceId, input.clientInstanceId),
    // The id may be any text a caller named, so it is compared as text, not as a known id.
    eq(platformJobs.id, sql`${input.id}`)
  );
  try {
    // Inside a caller's transaction this is a savepoint, so a refused statement leaves the
    // transaction usable.
    const [row] = await db.transaction((inner) =>
      inner
        .update(platformJobs)
        .set({
          status: "queued",
          attempts: 0,
          runAfter: sql`now()`,
          startedAt: null,
          finishedAt: null
        })
        .where(and(ofInstance, inArray(platformJobs.status, [...RETRYABLE_STATUSES])))
        .returning(overviewColumns)
    );
    if (row) return { outcome: "requeued", job: mapOverview(row) };
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: "superseded" };
    throw error;
  }
  const [found] = await db
    .select({ status: platformJobs.status })
    .from(platformJobs)
    .where(ofInstance);
  return found ? { outcome: "not_ended", status: found.status } : { outcome: "not_found" };
}

const UNIQUE_VIOLATION = "23505";

/** The driver's error carries the SQLSTATE; the query builder may wrap it as a cause. */
function isUniqueViolation(error: unknown): boolean {
  let current = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && current.code === UNIQUE_VIOLATION) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
