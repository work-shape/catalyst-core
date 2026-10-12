import { z } from "zod";
import type { DataStoreRecord, JobControl, PlatformStores } from "@vivd-catalyst/core";
import type { DataStoreRuntime } from "./runtime";

/** The share of its size limit from which a store is reported in the log as nearly full. */
const DATA_STORE_SIZE_WARNING_RATIO = 0.8;

/**
 * How many stores one measurement reads. An instance with more measures the first ones by
 * name and says so in the log.
 */
const DATA_STORE_MEASURE_MAX_STORES = 2_000;

const sizeRow = z.object({ bytes: z.string().regex(/^\d+$/u) });

type Transact = <Result>(work: (stores: PlatformStores) => Promise<Result>) => Promise<Result>;

/**
 * Measures one store and writes the size onto its record, as it is now: another write may
 * have landed since the caller read it. Answers the record as written, or nothing where the
 * store is gone. Throws where the database cannot be measured.
 */
export async function recordStoreSize(
  runtime: Pick<DataStoreRuntime, "clientInstanceId" | "server">,
  transaction: Transact,
  record: Pick<DataStoreRecord, "id" | "location">,
  signal: AbortSignal | undefined
): Promise<DataStoreRecord | undefined> {
  const { clientInstanceId, server } = runtime;
  const measured = await server.executor.query({
    ...server.asPlatform(server.platformDatabase),
    ...(signal ? { signal } : {}),
    sql: "select pg_catalog.pg_database_size($1::name)::text as bytes",
    parameters: [record.location.database]
  });
  const sizeBytes = Number(sizeRow.parse(measured.rows[0]).bytes);
  return transaction(async (stores) => {
    const current = await stores.dataStores.getDataStore({
      clientInstanceId,
      id: record.id,
      lock: true
    });
    if (!current) return undefined;
    const now = new Date().toISOString();
    const next = { ...current, sizeBytes, sizeMeasuredAt: now, updatedAt: now };
    await stores.dataStores.putDataStore(next);
    return next;
  });
}

/**
 * Records the size of every store that has a database, retired ones included: their rows
 * still take the disk. A store whose database cannot be measured keeps its last size.
 */
export async function measureDataStores(
  runtime: DataStoreRuntime,
  control: JobControl
): Promise<void> {
  const { clientInstanceId, logger } = runtime;
  const records = await runtime.stores.dataStores.listDataStores({
    clientInstanceId,
    limit: DATA_STORE_MEASURE_MAX_STORES + 1
  });
  if (records.length > DATA_STORE_MEASURE_MAX_STORES) {
    logger.warn(
      { limit: DATA_STORE_MEASURE_MAX_STORES, limitName: "DATA_STORE_MEASURE_MAX_STORES" },
      "More Data Stores exist than one measurement reads"
    );
  }
  for (const record of records.slice(0, DATA_STORE_MEASURE_MAX_STORES)) {
    if (record.status === "provisioning") continue;
    control.signal.throwIfAborted();
    const measured = await recordStoreSize(
      runtime,
      (work) => control.transaction(work),
      record,
      control.signal
    ).catch(() => {
      logger.warn({ storeId: record.id }, "The size of a Data Store could not be measured");
      return undefined;
    });
    if (
      measured?.sizeBytes !== undefined &&
      measured.sizeBytes >= measured.sizeLimitBytes * DATA_STORE_SIZE_WARNING_RATIO
    ) {
      logger.warn(
        {
          storeId: measured.id,
          name: measured.name,
          sizeBytes: measured.sizeBytes,
          sizeLimitBytes: measured.sizeLimitBytes
        },
        "A Data Store is at 80 percent of its size limit or above"
      );
    }
  }
}
