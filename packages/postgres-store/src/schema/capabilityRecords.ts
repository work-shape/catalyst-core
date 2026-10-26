import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgPolicy,
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

/**
 * The start of the name of every database role that the public host of the capability
 * `outside-forms` connects with (EW-9). Row-level security keeps such a role to that
 * capability's rows; an operator creates it, see the docs' operator runbook.
 */
export const OUTSIDE_FORMS_HOST_ROLE_PREFIX = "catalyst_outside_forms";

/**
 * Who a row of `capability_records` is for. The platform's role owns the table and row-level
 * security does not apply to it. Every other role gets what its grants give, as before the
 * policies (`by_grant`), and a role whose name starts with OUTSIDE_FORMS_HOST_ROLE_PREFIX only
 * the rows of `outside-forms`, for reading and for writing. Neither policy names a role, so the
 * migration needs no role to exist and no CREATEROLE.
 */
const outsideFormsHostRows = sql`capability = 'outside-forms' or not starts_with(current_user::text, ${sql.raw(`'${OUTSIDE_FORMS_HOST_ROLE_PREFIX}'`)})`;
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
    ),
    pgPolicy("capability_records_by_grant", {
      as: "permissive",
      for: "all",
      to: "public",
      using: sql`true`,
      withCheck: sql`true`
    }),
    pgPolicy("capability_records_outside_forms_host", {
      as: "restrictive",
      for: "all",
      to: "public",
      using: outsideFormsHostRows,
      withCheck: outsideFormsHostRows
    })
  ]
);
