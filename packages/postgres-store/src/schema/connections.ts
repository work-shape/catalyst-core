import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  ClientInstanceId,
  ConnectionHealth,
  JsonValue,
  SecretSource
} from "@vivd-catalyst/core";
import { configAssets } from "./configAssets";

const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea"
});

/**
 * The Secret Store: one row per Connection and credential subject. It holds ciphertext and
 * what is needed to open it with a key of release config, and never a value or a key. The
 * row leaves with its Connection. `stores/connections.ts` holds the only code that reads it.
 */
export const secrets = pgTable(
  "secrets",
  {
    handle: text("handle").primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    connectionAssetId: text("connection_asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    version: integer("version").notNull(),
    keyId: text("key_id").notNull(),
    nonce: bytes("nonce").notNull(),
    ciphertext: bytes("ciphertext").notNull(),
    source: text("source").$type<SecretSource>().notNull(),
    /** The origin the secret was set for. Null for a secret of no origin. */
    origin: text("origin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("secrets_connection_subject_idx").on(table.connectionAssetId, table.subject),
    index("secrets_client_idx").on(table.clientInstanceId),
    check("secrets_nonce_length_check", sql`octet_length(${table.nonce}) = 12`),
    check("secrets_version_check", sql`${table.version} >= 1`),
    check("secrets_source_check", sql`${table.source} in ('bootstrap', 'runtime')`)
  ]
);

/**
 * Runtime state of a Connection: its health, the last test and the catalog a discovery read.
 * It is no revision and holds no secret.
 */
export const connectionState = pgTable(
  "connection_state",
  {
    connectionAssetId: text("connection_asset_id")
      .primaryKey()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    health: text("health").$type<ConnectionHealth>().notNull(),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    catalog: jsonb("catalog").$type<JsonValue>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("connection_state_client_idx").on(table.clientInstanceId),
    check(
      "connection_state_health_check",
      sql`${table.health} in ('unknown', 'ok', 'failed', 'needs_configuration', 'secret_unreadable')`
    )
  ]
);
