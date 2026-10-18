import { z } from "zod";
import type { DataStoreRecord, JobControl, PlatformStores } from "@work-shape/catalyst-core";
import { DATA_STORE_MAINTENANCE_PAGE_SIZE } from "./maintenance";
import { measureSizePageJob, type MaintenancePayload } from "./store-job-kinds";
import { pruneCallRecords } from "./calls";
import { readStoreConditions } from "./provisioning";
import type { DataStoreRuntime } from "./runtime";
import type { DataStoreServer } from "./server";

/** The share of its size limit from which a store is reported in the log as nearly full. */
export const DATA_STORE_SIZE_WARNING_RATIO = 0.8;

const sizeRow = z.object({ bytes: z.string().regex(/^\d+$/u) });

/**
 * The size of a store's database as the server answers it to the platform's own role, on a
 * connection of the platform's own: nothing a store ran can have touched it. It counts the
 * files as they are now, whatever a transaction that is still open has written into them.
 */
export async function storeSizeBytes(
  server: DataStoreServer,
  database: string,
  signal: AbortSignal | undefined
): Promise<number> {
  const measured = await server.executor.query({
    ...server.asPlatform(server.platformDatabase),
    ...(signal ? { signal } : {}),
    sql: "select pg_catalog.pg_database_size($1::pg_catalog.name)::pg_catalog.text as bytes",
    parameters: [database]
  });
  return Number(sizeRow.parse(measured.rows[0]).bytes);
}

const tablesRow = z.object({
  tables: z.number().int(),
  rows: z.string().regex(/^\d+$/u)
});

/**
 * How many tables the schema `public` of a store holds and how many rows the planner
 * estimates in them, read from the catalog as the platform's own role. It reads no row. A
 * table the database has not analyzed yet counts as empty.
 */
async function storeTables(
  server: DataStoreServer,
  database: string,
  signal: AbortSignal | undefined
): Promise<{ tableCount: number; rowEstimate: number }> {
  const read = await server.executor.query({
    ...server.asPlatform(database),
    ...(signal ? { signal } : {}),
    sql: `select pg_catalog.count(*)::pg_catalog.int4 as tables,
        coalesce(pg_catalog.sum(greatest(c.reltuples, 0)), 0)::pg_catalog.int8::pg_catalog.text as rows
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')`
  });
  const { tables, rows } = tablesRow.parse(read.rows[0]);
  return { tableCount: tables, rowEstimate: Number(rows) };
}

type Transact = <Result>(work: (stores: PlatformStores) => Promise<Result>) => Promise<Result>;

/**
 * Measures one store and writes the size, the number of its tables and the estimate of their
 * rows onto its record, as it is now: another write may
 * have landed since the caller read it. Answers the record as written, or nothing where the
 * store is gone. Throws where the database cannot be measured.
 */
export async function recordStoreSize(
  runtime: Pick<DataStoreRuntime, "clientInstanceId" | "server">,
  transaction: Transact,
  record: Pick<DataStoreRecord, "id" | "location">,
  signal: AbortSignal | undefined
): Promise<DataStoreRecord | undefined> {
  const { clientInstanceId } = runtime;
  const sizeBytes = await storeSizeBytes(runtime.server, record.location.database, signal);
  const tables = await storeTables(runtime.server, record.location.database, signal);
  return transaction(async (stores) => {
    const current = await stores.dataStores.getDataStore({
      clientInstanceId,
      id: record.id,
      lock: true
    });
    if (!current) return undefined;
    const now = new Date().toISOString();
    const next = { ...current, sizeBytes, ...tables, sizeMeasuredAt: now, updatedAt: now };
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
  control: JobControl,
  payload: MaintenancePayload = {}
): Promise<void> {
  const { clientInstanceId, logger } = runtime;
  const records = await runtime.stores.dataStores.listDataStores({
    clientInstanceId,
    limit: DATA_STORE_MAINTENANCE_PAGE_SIZE + 1,
    ...(payload.after ? { after: payload.after } : {})
  });
  const page = records.slice(0, DATA_STORE_MAINTENANCE_PAGE_SIZE);
  for (const record of page) {
    if (record.status === "provisioning") continue;
    control.signal.throwIfAborted();
    // What the server leaves open is said as it is today, also where it was closed since.
    await readStoreConditions(runtime.server, record, control.signal)
      .then((conditions) =>
        control.transaction(async (stores) => {
          const current = await stores.dataStores.getDataStore({
            clientInstanceId,
            id: record.id,
            lock: true
          });
          if (current) await stores.dataStores.putDataStore({ ...current, conditions });
        })
      )
      .catch(() => undefined);
    // The records of calls that carried a key are kept as long as the data of a step is.
    await pruneCallRecords(runtime, record, control.signal).catch(() =>
      logger.warn({ storeId: record.id }, "The old call records of a Data Store were not removed")
    );
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
  const last = page.at(-1);
  if (last && records.length > page.length) {
    await control.transaction(async (stores) => {
      await stores.jobs.enqueue(
        measureSizePageJob,
        { after: { name: last.name, id: last.id } },
        {
          clientInstanceId,
          dedupeKey: `page:${last.id}`
        }
      );
    });
  }
}
