import { z } from "zod";
import type { JobControl } from "@vivd-catalyst/core";
import type { DataStoreRuntime } from "./runtime";

/** The share of its size limit from which a store is reported in the log as nearly full. */
const DATA_STORE_SIZE_WARNING_RATIO = 0.8;

/**
 * How many stores one measurement reads. An instance with more measures the first ones by
 * name and says so in the log.
 */
const DATA_STORE_MEASURE_MAX_STORES = 2_000;

const sizeRow = z.object({ bytes: z.string().regex(/^\d+$/u) });

/**
 * Records the size of every store that has a database, retired ones included: their rows
 * still take the disk. A store whose database cannot be measured keeps its last size.
 */
export async function measureDataStores(
  runtime: DataStoreRuntime,
  control: JobControl
): Promise<void> {
  const { clientInstanceId, server, logger } = runtime;
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
    let sizeBytes: number;
    try {
      const measured = await server.executor.query({
        ...server.asPlatform(server.platformDatabase),
        signal: control.signal,
        sql: "select pg_catalog.pg_database_size($1::name)::text as bytes",
        parameters: [record.location.database]
      });
      sizeBytes = Number(sizeRow.parse(measured.rows[0]).bytes);
    } catch {
      logger.warn({ storeId: record.id }, "The size of a Data Store could not be measured");
      continue;
    }
    await control.transaction(async (stores) => {
      const current = await stores.dataStores.getDataStore({
        clientInstanceId,
        id: record.id,
        lock: true
      });
      if (!current) return;
      const now = new Date().toISOString();
      await stores.dataStores.putDataStore({
        ...current,
        sizeBytes,
        sizeMeasuredAt: now,
        updatedAt: now
      });
    });
    if (sizeBytes >= record.sizeLimitBytes * DATA_STORE_SIZE_WARNING_RATIO) {
      logger.warn(
        { storeId: record.id, name: record.name, sizeBytes, sizeLimitBytes: record.sizeLimitBytes },
        "A Data Store is at 80 percent of its size limit or above"
      );
    }
  }
}
