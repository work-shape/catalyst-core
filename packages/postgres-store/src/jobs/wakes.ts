import { and, eq, lte, sql } from "drizzle-orm";
import type {
  ClientInstanceId,
  EnqueueJobOptions,
  Job,
  JobKind,
  JsonObject
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "../postgres-database";
import { jobWakes, platformJobs } from "../schema/jobs";

/** Bound work under the kind's claim lock; remaining wakes are taken on the next poll. */
const WAKE_BATCH_SIZE = 100;

/**
 * The claim's per-kind advisory lock serializes consumers. A wake is retained while its
 * key runs and consumed only into a queued job. This also works when the previous worker
 * is from the preceding release: it never needs to understand wakes. No subject row or
 * running job row is locked here, so subject-to-wake writes cannot invert executor locks.
 */
export async function enqueueDueWakes(
  db: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  kind: JobKind,
  enqueue: (kind: JobKind, payload: JsonObject, options: EnqueueJobOptions) => Promise<Job>
): Promise<void> {
  const wakes = await db
    .select()
    .from(jobWakes)
    .where(
      and(
        eq(jobWakes.clientInstanceId, clientInstanceId),
        eq(jobWakes.kind, kind.kind),
        lte(jobWakes.runAfter, sql`now()`),
        sql`not exists (select 1 from ${platformJobs} running where running.client_instance_id = ${jobWakes.clientInstanceId} and running.kind = ${jobWakes.kind} and running.dedupe_key = ${jobWakes.dedupeKey} and running.status = 'running')`
      )
    )
    .limit(WAKE_BATCH_SIZE)
    .for("update");
  for (const wake of wakes) {
    const job = await enqueue(kind, wake.payload, {
      clientInstanceId,
      dedupeKey: wake.dedupeKey,
      runAfter: wake.runAfter,
      ...(wake.subject === null ? {} : { subject: wake.subject }),
      ...(wake.concurrencyKey === null ? {} : { concurrencyKey: wake.concurrencyKey }),
      ...(wake.concurrencyLimit === null ? {} : { concurrencyLimit: wake.concurrencyLimit }),
      correlationId: wake.correlationId
    });
    if (job.status !== "queued") continue;
    // An existing queued attempt satisfies the wake, at the earlier of their due times.
    await db
      .update(platformJobs)
      .set({
        runAfter: sql`least(${platformJobs.runAfter}, ${wake.runAfter.toISOString()}::timestamptz)`
      })
      .where(and(eq(platformJobs.id, job.id), eq(platformJobs.status, "queued")));
    await db
      .delete(jobWakes)
      .where(
        and(
          eq(jobWakes.clientInstanceId, clientInstanceId),
          eq(jobWakes.kind, kind.kind),
          eq(jobWakes.dedupeKey, wake.dedupeKey)
        )
      );
  }
}
