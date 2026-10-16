import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { DataStoreRecord, DataStoreRecordsStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { dataStores } from "./schema";

type Row = typeof dataStores.$inferSelect;

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
    async listDataStores({ clientInstanceId, limit }) {
      const rows = await db
        .select()
        .from(dataStores)
        .where(eq(dataStores.clientInstanceId, clientInstanceId))
        .orderBy(asc(dataStores.name))
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
    }
  };
}
