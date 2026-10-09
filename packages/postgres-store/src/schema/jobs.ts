import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { ClientInstanceId, JobId, JobStatus, JsonObject } from "@vivd-catalyst/core";

/** The one queue of the product. `jobs/` holds the only code that reads or writes it. */
export const platformJobs = pgTable(
  "platform_jobs",
  {
    id: text("id").$type<JobId>().primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    kind: text("kind").notNull(),
    subject: text("subject"),
    payload: jsonb("payload").$type<JsonObject>().notNull(),
    status: text("status").$type<JobStatus>().notNull(),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    dedupeKey: text("dedupe_key"),
    concurrencyKey: text("concurrency_key"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [
    // What a worker asks every second: the due and the running jobs of a kind.
    index("platform_jobs_claim_idx").on(
      table.clientInstanceId,
      table.kind,
      table.status,
      table.runAfter
    ),
    // One live job per dedupe key of a kind.
    uniqueIndex("platform_jobs_live_dedupe_idx")
      .on(table.clientInstanceId, table.kind, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null and ${table.status} in ('queued', 'running')`),
    index("platform_jobs_finished_idx").on(table.clientInstanceId, table.finishedAt)
  ]
);
