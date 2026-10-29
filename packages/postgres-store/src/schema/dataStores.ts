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
} from "@work-shape/catalyst-core";

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
    tableCount: integer("table_count"),
    rowEstimate: bigint("row_estimate", { mode: "number" }),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    conditions: jsonb("conditions").$type<DataStoreCondition[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    // The id of the Knowledge Base whose documents the store keeps, which owns it: it is made
    // when that Knowledge Base is published and dropped when it is deleted. Null for a store
    // of its own asset.
    ownerKnowledgeBaseId: text("owner_knowledge_base_id")
  },
  (table) => [
    // A name is held while its record exists, retired or not: the database of a retired
    // store is still there under it.
    uniqueIndex("data_stores_client_name_idx").on(table.clientInstanceId, table.name),
    check("data_stores_status_check", sql`${table.status} in ('provisioning', 'ready', 'retired')`),
    check("data_stores_level_check", sql`${table.level} >= 0`)
  ]
);

/**
 * The test copy of a Data Store (ADR-0031, DT-2): the scratch database its drafts reach,
 * built from the migrations of the store's draft and its seed files, never from a live row. One
 * row per store at most, while the copy's database exists; dropping the copy removes the row.
 * It holds no row of the copy and no credential: the copy is reached as the store's own roles.
 */
export const dataStoreTestCopies = pgTable("data_store_test_copies", {
  storeId: text("store_id")
    .primaryKey()
    .references(() => dataStores.id, { onDelete: "cascade" }),
  clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
  databaseName: text("database_name").notNull(),
  migrations: jsonb("migrations").$type<DataStoreAppliedMigration[]>().notNull(),
  seedSha256: text("seed_sha256").notNull(),
  seedFiles: integer("seed_files").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull(),
  builtBy: text("built_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});
