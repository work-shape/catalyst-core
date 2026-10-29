import { dataStoreRefusalError, type DataStoreRecord } from "@work-shape/catalyst-core";

// The wait of one Publish of an App or a Workflow for the Data Stores it published with it
// (GOLIVE-1, LIVE-2): each store's own publish wrote its record and queued its migrate job, and
// the job writes each applied level and a failure onto the record. The wait reads the record and nothing else, so
// there is one way a store migrates. Spec: apps-and-pages.md, Going live without getting lost.

/** How long one Publish of an App waits for the stores it publishes to reach their level. */
const STORE_MIGRATION_WAIT_MS = 60_000;

/** How often the wait reads the records. */
const STORE_MIGRATION_POLL_MS = 250;

/** One store the wait is for. */
export interface StoreAwaited {
  name: string;
  /** The store's title as people read it, which a refusal names for the interface. */
  title: string;
  /** The id of the store's asset, which its record has. */
  storeId: string;
  /** The level the store must reach: the last migration of the revision published. */
  level: number;
  /** The names of that revision's migrations, by number, to name the one that failed. */
  migrations: ReadonlyMap<number, string>;
}

export interface StoreWaitClock {
  timeoutMs: number;
  pollMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realStoreWaitClock: StoreWaitClock = {
  timeoutMs: STORE_MIGRATION_WAIT_MS,
  pollMs: STORE_MIGRATION_POLL_MS,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/**
 * Waits until every store is ready at its level. It refuses with `data_store_migration_failed`
 * as soon as a store's record holds a failure, naming the migration after the last applied
 * one, and with `data_store_migrating` once the time is up. A failure on the record is the
 * job's outcome: an attempt that is tried again writes none, and a store's publish clears the
 * one an earlier job left.
 * A store whose record is gone or retired is `data_store_unavailable`.
 */
export async function awaitStoreLevels(
  read: (storeId: string) => Promise<DataStoreRecord | undefined>,
  stores: readonly StoreAwaited[],
  clock: StoreWaitClock = realStoreWaitClock,
  /** A Workflow's Publish waits (LIVE-2): its refusals say the Workflow did not go live. */
  publishing?: "workflow"
): Promise<void> {
  const of = publishing ? { publishing } : {};
  const deadline = clock.now() + clock.timeoutMs;
  let waiting = [...stores];
  for (;;) {
    const still: StoreAwaited[] = [];
    for (const store of waiting) {
      const record = await read(store.storeId);
      if (!record || record.status === "retired") {
        throw dataStoreRefusalError("data_store_unavailable", store.name);
      }
      if (record.status === "ready" && record.level >= store.level) continue;
      if (record.failure) {
        const number = record.level + 1;
        throw dataStoreRefusalError(
          record.failure.code === "job_exhausted"
            ? "data_store_job_exhausted"
            : "data_store_migration_failed",
          store.name,
          {
            title: store.title,
            migration: store.migrations.get(number) ?? String(number),
            level: record.level,
            failure: record.failure.message,
            ...of
          }
        );
      }
      still.push(store);
    }
    waiting = still;
    const [first] = waiting;
    if (!first) return;
    if (clock.now() >= deadline) {
      const record = await read(first.storeId);
      throw dataStoreRefusalError("data_store_migrating", first.name, {
        title: first.title,
        level: record?.level ?? 0,
        minSchema: first.level,
        retryable: true,
        ...of
      });
    }
    await clock.sleep(clock.pollMs);
  }
}
