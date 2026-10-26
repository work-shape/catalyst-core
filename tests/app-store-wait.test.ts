import { describe, expect, it } from "vitest";
import { isAppError, type DataStoreRecord } from "@work-shape/catalyst-core";
import {
  awaitStoreLevels,
  type StoreAwaited,
  type StoreWaitClock
} from "@work-shape/catalyst-server";
import { clientInstanceId } from "./support/access-instance";

// GOLIVE-1's wait, on records a test writes: an App's Publish waits for the stores it published
// to reach their level and reads only their records.

const record = (overrides: Partial<DataStoreRecord>): DataStoreRecord => ({
  id: "ast_store",
  clientInstanceId,
  name: "ledger",
  status: "ready",
  location: { host: "db", port: 5432, database: "store_ledger" },
  roles: { app: "app", migration: "migration" },
  level: 1,
  migrations: [],
  targetRevision: 2,
  sizeLimitBytes: 1024,
  conditions: [],
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  ...overrides
});

const store: StoreAwaited = {
  name: "ledger",
  title: "Ledger",
  storeId: "ast_store",
  level: 2,
  migrations: new Map([
    [1, "init"],
    [2, "add_note"]
  ])
};

/** A clock that moves one poll at each sleep. */
const steppingClock = (timeoutMs = 1_000): StoreWaitClock => {
  let now = 0;
  return {
    timeoutMs,
    pollMs: 100,
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    }
  };
};

/** The records the reads answer, one per read, the last one from then on. */
const reads = (...records: DataStoreRecord[]) => {
  let index = 0;
  return () => Promise.resolve(records[Math.min(index++, records.length - 1)]);
};

const refusalOf = async (wait: Promise<void>) => {
  try {
    await wait;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error("The wait did not refuse");
};

describe("the wait of an App's Publish for the stores it publishes", () => {
  it("ends once each store is ready at its level", async () => {
    await expect(
      awaitStoreLevels(reads(record({ level: 1 }), record({ level: 2 })), [store], steppingClock())
    ).resolves.toBeUndefined();
  });

  it("names the migration after the last applied one when the job writes a failure", async () => {
    const failure = { code: "migration_failed", message: "'0002_add_note.sql' failed." };
    expect(
      await refusalOf(
        awaitStoreLevels(reads(record({}), record({ failure })), [store], steppingClock())
      )
    ).toEqual({
      code: "CONFLICT",
      details: {
        reason: "data_store_migration_failed",
        dataStore: "ledger",
        title: "Ledger",
        migration: "add_note",
        level: 1,
        failure: failure.message
      }
    });
  });

  it("answers data_store_migrating, retryable, once the time is up", async () => {
    expect(
      await refusalOf(awaitStoreLevels(reads(record({ level: 1 })), [store], steppingClock(250)))
    ).toEqual({
      code: "CONFLICT",
      details: {
        reason: "data_store_migrating",
        dataStore: "ledger",
        title: "Ledger",
        level: 1,
        minSchema: 2,
        retryable: true
      }
    });
  });

  it("waits for a store that is still provisioning, and refuses one that was retired", async () => {
    await expect(
      awaitStoreLevels(
        reads(record({ status: "provisioning", level: 0 }), record({ level: 2 })),
        [store],
        steppingClock()
      )
    ).resolves.toBeUndefined();
    expect(
      (await refusalOf(awaitStoreLevels(reads(record({ status: "retired" })), [store]))).details
    ).toMatchObject({ reason: "data_store_unavailable" });
  });
});
