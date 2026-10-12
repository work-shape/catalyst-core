import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  ClientInstanceId,
  DataStoreAppliedMigration,
  DataStoreCondition,
  DataStoreStatus
} from "@vivd-catalyst/core";

/**
 * One row per Data Store: where its database is, the roles that reach it, the migrations it
 * has applied and its size. The id is the id of the store's asset and no foreign key: the row
 * stays when the asset is deleted, because the database does. It holds no credential.
 * `stores/dataStores.ts` holds the only code that reads or writes it.
 */
export const dataStores = pgTable(
  "data_stores",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    name: text("name").notNull(),
    status: text("status").$type<DataStoreStatus>().notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    databaseName: text("database_name").notNull(),
    appRole: text("app_role").notNull(),
    migrationRole: text("migration_role").notNull(),
    level: integer("level").notNull(),
    migrations: jsonb("migrations").$type<DataStoreAppliedMigration[]>().notNull(),
    targetRevision: integer("target_revision").notNull(),
    sizeLimitBytes: bigint("size_limit_bytes", { mode: "number" }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sizeMeasuredAt: timestamp("size_measured_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    conditions: jsonb("conditions").$type<DataStoreCondition[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true })
  },
  (table) => [
    // A name is held while its record exists, retired or not: the database of a retired
    // store is still there under it.
    uniqueIndex("data_stores_client_name_idx").on(table.clientInstanceId, table.name),
    check("data_stores_status_check", sql`${table.status} in ('provisioning', 'ready', 'retired')`),
    check("data_stores_level_check", sql`${table.level} >= 0`)
  ]
);
