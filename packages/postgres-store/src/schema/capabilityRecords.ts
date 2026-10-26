import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type { ClientInstanceId, JsonObject } from "@work-shape/catalyst-core";

/**
 * The working state a capability keeps of its own process (ADR-0033), such as a form's draft.
 * A capability reads and writes only its own rows, through its port. Nothing here references a
 * platform table, and nothing of the platform reads it.
 */
export const capabilityRecords = pgTable(
  "capability_records",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    capability: text("capability").notNull(),
    kind: text("kind").notNull(),
    id: text("id").notNull(),
    key: text("key"),
    status: text("status").notNull(),
    document: jsonb("document").$type<JsonObject>().notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({
      name: "capability_records_pk",
      columns: [table.clientInstanceId, table.capability, table.kind, table.id]
    }),
    uniqueIndex("capability_records_key_idx")
      .on(table.clientInstanceId, table.capability, table.kind, table.key)
      .where(sql`${table.key} is not null`),
    // What a capability's process claims: its records of one status, soonest to expire first.
    index("capability_records_status_idx").on(
      table.clientInstanceId,
      table.capability,
      table.kind,
      table.status,
      table.expiresAt
    ),
    index("capability_records_expiry_idx").on(
      table.clientInstanceId,
      table.capability,
      table.expiresAt
    )
  ]
);
