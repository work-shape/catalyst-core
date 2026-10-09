import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type { ApiCredentialRecord, ServicePrincipalRecord } from "@vivd-catalyst/core";
import { productUsers } from "./users";

export const servicePrincipals = pgTable(
  "service_principals",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    displayLabel: text("display_label").notNull(),
    description: text("description"),
    status: text("status").$type<ServicePrincipalRecord["status"]>().notNull(),
    permissionRefs: jsonb("permission_refs").$type<string[]>().notNull().default([]),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    createdByClientInstanceId: text("created_by_client_instance_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
  },
  (table) => [
    index("service_principals_client_label_idx").on(table.clientInstanceId, table.displayLabel),
    uniqueIndex("service_principals_client_id_idx").on(table.clientInstanceId, table.id),
    foreignKey({
      name: "service_principals_client_creator_fk",
      columns: [table.createdByClientInstanceId, table.createdByUserId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("set null"),
    check(
      "service_principals_creator_client_check",
      sql`(${table.createdByUserId} is null and ${table.createdByClientInstanceId} is null) or (${table.createdByUserId} is not null and ${table.createdByClientInstanceId} is not null and ${table.createdByClientInstanceId} = ${table.clientInstanceId})`
    )
  ]
);

export const apiCredentials = pgTable(
  "api_credentials",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    servicePrincipalId: text("service_principal_id").notNull(),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    scopes: jsonb("scopes").$type<ApiCredentialRecord["scopes"]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("api_credentials_key_prefix_idx").on(table.keyPrefix),
    index("api_credentials_client_principal_idx").on(
      table.clientInstanceId,
      table.servicePrincipalId
    ),
    foreignKey({
      name: "api_credentials_client_principal_fk",
      columns: [table.clientInstanceId, table.servicePrincipalId],
      foreignColumns: [servicePrincipals.clientInstanceId, servicePrincipals.id]
    }).onDelete("cascade")
  ]
);
