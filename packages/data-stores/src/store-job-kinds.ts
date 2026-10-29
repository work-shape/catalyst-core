import { z } from "zod";
import {
  DATA_STORE_JOB_KINDS,
  defineJobKind,
  scheduledJobPayloadSchema,
  subjectDedupeKey,
  type DataStoreRecord,
  type Job,
  type PlatformStores
} from "@work-shape/catalyst-core";

const maintenancePayloadSchema = z.object({
  after: z.object({ name: z.string(), id: z.string() }).optional()
});
export type MaintenancePayload = z.infer<typeof maintenancePayloadSchema>;

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

/**
 * How often provisioning and a migration are tried while the database server is busy or away,
 * with waits that double from 5 seconds up to 2 minutes. An error another attempt cannot mend
 * ends the job at once. Publishing again queues a new job.
 */
const DATA_STORE_JOB_MAX_ATTEMPTS = 5;
const DATA_STORE_JOB_BACKOFF = { baseMs: 5 * SECOND_MS, maxMs: 2 * MINUTE_MS } as const;
/** A job whose lease is this old without a heartbeat lost its process. */
const DATA_STORE_JOB_LEASE_MS = 2 * MINUTE_MS;
/** How many stores are provisioned or migrated at once across the instance, and in one process. */
const DATA_STORE_JOBS_MAX_RUNNING = 4;
export const DATA_STORE_JOB_SLOTS = 2;
/** How often the size of every store is measured. */
export const DATA_STORE_MEASURE_INTERVAL_MS = 24 * 60 * MINUTE_MS;
/**
 * How often the stores Knowledge Bases own are checked against the release's tables, besides
 * at each start.
 */
export const DATA_STORE_UPGRADE_INTERVAL_MS = 24 * 60 * MINUTE_MS;

const storePayloadSchema = z.object({ storeId: z.string().min(1).max(200) });
export type StorePayload = z.infer<typeof storePayloadSchema>;

const storeJob = {
  payloadSchema: storePayloadSchema,
  maxAttempts: DATA_STORE_JOB_MAX_ATTEMPTS,
  backoff: DATA_STORE_JOB_BACKOFF,
  leaseMs: DATA_STORE_JOB_LEASE_MS,
  concurrency: { global: DATA_STORE_JOBS_MAX_RUNNING, perKey: 1 }
} as const;

/** Creates the database and the roles of one store. The payload names the store and holds nothing of it. */
export const provisionJob = defineJobKind({ ...storeJob, kind: DATA_STORE_JOB_KINDS.provision });

/**
 * Applies the migrations the published revision of one store has and its database lacks. For
 * the store a Knowledge Base owns, they are the platform's tables of this release.
 */
export const migrateJob = defineJobKind({ ...storeJob, kind: DATA_STORE_JOB_KINDS.migrate });

/** Drops the database, the roles and the record of a store whose Knowledge Base was deleted. */
export const dropJob = defineJobKind({ ...storeJob, kind: DATA_STORE_JOB_KINDS.drop });

export const measureSizeJob = defineJobKind({
  kind: DATA_STORE_JOB_KINDS.measureSize,
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 10 * MINUTE_MS,
  concurrency: { global: 1 },
  manualRetry: false
});

/**
 * Queues the migration of every store a Knowledge Base owns whose tables are behind the
 * release. Due at each start, so a store an earlier release made gets the tables of this one
 * without a publish: an operation that needs them refuses until then.
 */
export const upgradeOwnedJob = defineJobKind({
  kind: DATA_STORE_JOB_KINDS.upgradeOwned,
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 10 * MINUTE_MS,
  concurrency: { global: 1 },
  manualRetry: false
});

/**
 * Queues the job that brings a store to its published revision: provisioning while it has no
 * database, a migration after. While one is queued for the store this inserts nothing.
 * `behind` names a job that is running and has read the published revision already: the new
 * one is then queued under the store's second key, and runs once that one ended.
 */
export async function enqueueStoreJob(
  stores: Pick<PlatformStores, "jobs">,
  record: Pick<DataStoreRecord, "id" | "clientInstanceId" | "status">,
  behind?: Pick<Job, "dedupeKey">
): Promise<void> {
  const kind = record.status === "provisioning" ? provisionJob : migrateJob;
  const first = subjectDedupeKey(kind.kind, record.id);
  await stores.jobs.enqueue(
    kind,
    { storeId: record.id },
    {
      clientInstanceId: record.clientInstanceId,
      subject: record.id,
      dedupeKey: behind?.dedupeKey === first ? `${first}:next` : first,
      concurrencyKey: record.id
    }
  );
}

/**
 * Queues the job that drops the store a deleted Knowledge Base owned. While one is queued for
 * the store this inserts nothing.
 */
export async function enqueueStoreDrop(
  stores: Pick<PlatformStores, "jobs">,
  record: Pick<DataStoreRecord, "id" | "clientInstanceId">
): Promise<void> {
  await stores.jobs.enqueue(
    dropJob,
    { storeId: record.id },
    {
      clientInstanceId: record.clientInstanceId,
      subject: record.id,
      dedupeKey: subjectDedupeKey(dropJob.kind, record.id),
      concurrencyKey: record.id
    }
  );
}

/** Drops the test copy of a store whose asset was deleted (DT-2). The store's own database stays. */
export const dropTestCopyJob = defineJobKind({
  ...storeJob,
  kind: DATA_STORE_JOB_KINDS.dropTestCopy
});

/** Queues the drop of a retired store's test copy, in the transaction that retires it. */
export async function enqueueTestCopyDrop(
  stores: Pick<PlatformStores, "jobs">,
  record: Pick<DataStoreRecord, "id" | "clientInstanceId">
): Promise<void> {
  await stores.jobs.enqueue(
    dropTestCopyJob,
    { storeId: record.id },
    {
      clientInstanceId: record.clientInstanceId,
      subject: record.id,
      dedupeKey: subjectDedupeKey(dropTestCopyJob.kind, record.id),
      concurrencyKey: record.id
    }
  );
}

// Keep legacy ticks empty: workers of the preceding release still serve these names.
// Cursor jobs have distinct names, so those workers cannot claim or reject their payloads.
const maintenancePageJob = {
  payloadSchema: maintenancePayloadSchema,
  maxAttempts: DATA_STORE_JOB_MAX_ATTEMPTS,
  backoff: DATA_STORE_JOB_BACKOFF,
  leaseMs: 10 * MINUTE_MS,
  concurrency: { global: 1 },
  manualRetry: false
} as const;
export const measureSizePageJob = defineJobKind({
  ...maintenancePageJob,
  kind: DATA_STORE_JOB_KINDS.measureSizePage
});
export const upgradeOwnedPageJob = defineJobKind({
  ...maintenancePageJob,
  kind: DATA_STORE_JOB_KINDS.upgradeOwnedPage
});

// New schedules use names old workers do not serve, including the startup upgrade tick.
export const measureSizeTickJob = defineJobKind({
  ...measureSizeJob,
  kind: DATA_STORE_JOB_KINDS.measureSizeTick
});
export const upgradeOwnedTickJob = defineJobKind({
  ...upgradeOwnedJob,
  kind: DATA_STORE_JOB_KINDS.upgradeOwnedTick
});
