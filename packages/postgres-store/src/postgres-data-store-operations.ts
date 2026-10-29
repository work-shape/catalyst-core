import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type {
  DataStoreRecord,
  DataStoreRecordsStore,
  DataStoreTestCopy
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { dataStoreTestCopies, dataStores } from "./schema";

type Row = typeof dataStores.$inferSelect;
type TestCopyRow = typeof dataStoreTestCopies.$inferSelect;

function mapTestCopy(row: TestCopyRow): DataStoreTestCopy {
  return {
    storeId: row.storeId,
    clientInstanceId: row.clientInstanceId,
    database: row.databaseName,
    migrations: row.migrations,
    seedSha256: row.seedSha256,
    seedFiles: row.seedFiles,
    ...(row.sizeBytes === null ? {} : { sizeBytes: row.sizeBytes }),
    builtAt: row.builtAt.toISOString(),
    builtBy: row.builtBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function testCopyRowOf(copy: DataStoreTestCopy): TestCopyRow {
  return {
    storeId: copy.storeId,
    clientInstanceId: copy.clientInstanceId,
    databaseName: copy.database,
    migrations: copy.migrations,
    seedSha256: copy.seedSha256,
    seedFiles: copy.seedFiles,
    sizeBytes: copy.sizeBytes ?? null,
    builtAt: new Date(copy.builtAt),
    builtBy: copy.builtBy,
    createdAt: new Date(copy.createdAt),
    updatedAt: new Date(copy.updatedAt)
  };
}

function mapRecord(row: Row): DataStoreRecord {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    name: row.name,
    status: row.status,
    location: { host: row.host, port: row.port, database: row.databaseName },
    roles: { app: row.appRole, migration: row.migrationRole },
    level: row.level,
    migrations: row.migrations,
    targetRevision: row.targetRevision,
    sizeLimitBytes: row.sizeLimitBytes,
    ...(row.sizeBytes === null ? {} : { sizeBytes: row.sizeBytes }),
    ...(row.sizeMeasuredAt ? { sizeMeasuredAt: row.sizeMeasuredAt.toISOString() } : {}),
    ...(row.tableCount === null ? {} : { tableCount: row.tableCount }),
    ...(row.rowEstimate === null ? {} : { rowEstimate: row.rowEstimate }),
    ...(row.failureCode === null || row.failureMessage === null
      ? {}
      : { failure: { code: row.failureCode, message: row.failureMessage } }),
    conditions: row.conditions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.retiredAt ? { retiredAt: row.retiredAt.toISOString() } : {}),
    ...(row.ownerKnowledgeBaseId === null ? {} : { ownerKnowledgeBaseId: row.ownerKnowledgeBaseId })
  };
}

function rowOf(record: DataStoreRecord): Row {
  return {
    id: record.id,
    clientInstanceId: record.clientInstanceId,
    name: record.name,
    status: record.status,
    host: record.location.host,
    port: record.location.port,
    databaseName: record.location.database,
    appRole: record.roles.app,
    migrationRole: record.roles.migration,
    level: record.level,
    migrations: record.migrations,
    targetRevision: record.targetRevision,
    sizeLimitBytes: record.sizeLimitBytes,
    sizeBytes: record.sizeBytes ?? null,
    sizeMeasuredAt: record.sizeMeasuredAt ? new Date(record.sizeMeasuredAt) : null,
    tableCount: record.tableCount ?? null,
    rowEstimate: record.rowEstimate ?? null,
    failureCode: record.failure?.code ?? null,
    failureMessage: record.failure?.message ?? null,
    conditions: record.conditions,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    retiredAt: record.retiredAt ? new Date(record.retiredAt) : null,
    ownerKnowledgeBaseId: record.ownerKnowledgeBaseId ?? null
  };
}

/** The only code that reads or writes `data_stores`. */
export function createPostgresDataStoreRecordsStore(db: PostgresConnection): DataStoreRecordsStore {
  return {
    async getDataStore({ clientInstanceId, id, lock }) {
      const query = db
        .select()
        .from(dataStores)
        .where(and(eq(dataStores.clientInstanceId, clientInstanceId), eq(dataStores.id, id)))
        .limit(1);
      const [row] = await (lock ? query.for("update") : query);
      return row ? mapRecord(row) : undefined;
    },
    async findDataStoreByName({ clientInstanceId, name }) {
      const [row] = await db
        .select()
        .from(dataStores)
        .where(and(eq(dataStores.clientInstanceId, clientInstanceId), eq(dataStores.name, name)))
        .limit(1);
      return row ? mapRecord(row) : undefined;
    },
    async listDataStores({ clientInstanceId, limit, after }) {
      const rows = await db
        .select()
        .from(dataStores)
        .where(
          and(
            eq(dataStores.clientInstanceId, clientInstanceId),
            after
              ? or(
                  gt(dataStores.name, after.name),
                  and(eq(dataStores.name, after.name), gt(dataStores.id, after.id))
                )
              : undefined
          )
        )
        .orderBy(asc(dataStores.name), asc(dataStores.id))
        .limit(limit);
      return rows.map(mapRecord);
    },
    async listDataStoresNaming({ clientInstanceId, database, roles }) {
      const rows = await db
        .select()
        .from(dataStores)
        .where(
          and(
            eq(dataStores.clientInstanceId, clientInstanceId),
            or(
              eq(dataStores.databaseName, database),
              inArray(dataStores.appRole, [...roles]),
              inArray(dataStores.migrationRole, [...roles])
            )
          )
        )
        .orderBy(asc(dataStores.id));
      return rows.map(mapRecord);
    },
    async putDataStore(record) {
      const { id, createdAt, ...changed } = rowOf(record);
      await db
        .insert(dataStores)
        .values({ id, createdAt, ...changed })
        .onConflictDoUpdate({ target: dataStores.id, set: changed });
    },
    async deleteDataStore({ clientInstanceId, id }) {
      await db
        .delete(dataStores)
        .where(and(eq(dataStores.clientInstanceId, clientInstanceId), eq(dataStores.id, id)));
    },
    async getTestCopy({ clientInstanceId, storeId, lock }) {
      // The turn of the store's copy, also before a first copy has a row to lock.
      if (lock) {
        await db.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["data-store-test-copy", clientInstanceId, storeId])}, 0))`
        );
      }
      const [row] = await db
        .select()
        .from(dataStoreTestCopies)
        .where(
          and(
            eq(dataStoreTestCopies.clientInstanceId, clientInstanceId),
            eq(dataStoreTestCopies.storeId, storeId)
          )
        )
        .limit(1);
      return row ? mapTestCopy(row) : undefined;
    },
    async putTestCopy(copy) {
      const { storeId, createdAt, ...changed } = testCopyRowOf(copy);
      await db
        .insert(dataStoreTestCopies)
        .values({ storeId, createdAt, ...changed })
        .onConflictDoUpdate({ target: dataStoreTestCopies.storeId, set: changed });
    },
    async deleteTestCopy({ clientInstanceId, storeId }) {
      await db
        .delete(dataStoreTestCopies)
        .where(
          and(
            eq(dataStoreTestCopies.clientInstanceId, clientInstanceId),
            eq(dataStoreTestCopies.storeId, storeId)
          )
        );
    }
  };
}
