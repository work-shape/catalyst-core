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
import type { ServicePrincipalRecord } from "@work-shape/catalyst-core";
import { productUsers } from "./users";

export const servicePrincipals = pgTable(
  "service_principals",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    // The store always writes it. The default is for a release that does not know the column
    // and runs beside this one during a deploy: its rows get a random name.
    name: text("name")
      .notNull()
      .default(
        sql`('principal-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12))`
      ),
    ownerKind: text("owner_kind"),
    ownerAssetId: text("owner_asset_id"),
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
    uniqueIndex("service_principals_client_owner_idx").on(
      table.clientInstanceId,
      table.ownerKind,
      table.ownerAssetId
    ),
    index("service_principals_client_label_idx").on(table.clientInstanceId, table.displayLabel),
    uniqueIndex("service_principals_client_id_idx").on(table.clientInstanceId, table.id),
    uniqueIndex("service_principals_client_name_idx").on(table.clientInstanceId, table.name),
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
    // Exactly one owner: a service principal, or the user of a personal key.
    servicePrincipalId: text("service_principal_id"),
    ownerUserId: text("owner_user_id"),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    // `["*"]` for every scope of the principal. Null only in a row a release before AP-4 wrote;
    // the column becomes required once no supported release writes null.
    scopes: jsonb("scopes").$type<string[]>(),
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
    // A person's keys, newest first, for their own list and the instance's.
    index("api_credentials_client_owner_created_idx")
      .on(table.clientInstanceId, table.ownerUserId, table.createdAt, table.id)
      .where(sql`${table.ownerUserId} is not null`),
    index("api_credentials_client_personal_created_idx")
      .on(table.clientInstanceId, table.createdAt, table.id)
      .where(sql`${table.ownerUserId} is not null`),
    foreignKey({
      name: "api_credentials_client_principal_fk",
      columns: [table.clientInstanceId, table.servicePrincipalId],
      foreignColumns: [servicePrincipals.clientInstanceId, servicePrincipals.id]
    }).onDelete("cascade"),
    // A deleted user's keys go with them.
    foreignKey({
      name: "api_credentials_client_owner_fk",
      columns: [table.clientInstanceId, table.ownerUserId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("cascade"),
    check(
      "api_credentials_one_owner_check",
      sql`(${table.servicePrincipalId} is null) <> (${table.ownerUserId} is null)`
    )
  ]
);

/**
 * A connect code between its start by the CLI and the collection of its key. The code a
 * person types and the CLI's own code are stored as hashes. Approval fixes the owner, the
 * name, the scopes and the expiry of the key; collection issues the key and marks the row.
 */
export const apiConnectCodes = pgTable(
  "api_connect_codes",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    userCodeHash: text("user_code_hash").notNull(),
    deviceCodeHash: text("device_code_hash").notNull(),
    clientLabel: text("client_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ownerUserId: text("owner_user_id"),
    keyName: text("key_name"),
    keyScopes: jsonb("key_scopes").$type<string[]>(),
    keyExpiresAt: timestamp("key_expires_at", { withTimezone: true }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    credentialId: text("credential_id")
  },
  (table) => [
    uniqueIndex("api_connect_codes_device_code_idx").on(table.deviceCodeHash),
    uniqueIndex("api_connect_codes_client_user_code_idx").on(
      table.clientInstanceId,
      table.userCodeHash
    ),
    index("api_connect_codes_expires_idx").on(table.clientInstanceId, table.expiresAt),
    foreignKey({
      name: "api_connect_codes_client_owner_fk",
      columns: [table.clientInstanceId, table.ownerUserId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("cascade"),
    check(
      "api_connect_codes_approval_check",
      sql`(${table.approvedAt} is null) = (${table.ownerUserId} is null) and (${table.approvedAt} is null) = (${table.keyScopes} is null) and (${table.approvedAt} is null) = (${table.keyExpiresAt} is null) and (${table.approvedAt} is null) = (${table.keyName} is null)`
    )
  ]
);
