import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  FollowUpMode,
  LocaleCode,
  UserModelPreference,
  UserRecord,
  UserStatus
} from "@work-shape/catalyst-core";

export const productUsers = pgTable(
  "product_users",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    displayLabel: text("display_label").notNull(),
    email: text("email"),
    groups: jsonb("groups").$type<string[]>().notNull().default([]),
    roles: jsonb("roles").$type<UserRecord["roles"]>().notNull(),
    permissionRefs: jsonb("permission_refs").$type<string[]>().notNull(),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    status: text("status").$type<UserStatus>().notNull(),
    modelPreference: jsonb("model_preference").$type<UserModelPreference>(),
    /** The language the person chose; null follows the instance's default. */
    locale: text("locale").$type<LocaleCode>(),
    /** What a message sent during the person's own run does: wait as the next turn, or steer it. */
    followUpMode: text("follow_up_mode").$type<FollowUpMode>().notNull().default("queue"),
    /** Set when the deletion of the account was accepted. The user is closed from then on. */
    deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true })
  },
  (table) => [
    index("product_users_client_idx").on(table.clientInstanceId),
    uniqueIndex("product_users_client_id_idx").on(table.clientInstanceId, table.id)
  ]
);

export const userIdentities = pgTable(
  "user_identities",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => productUsers.id, { onDelete: "cascade" }),
    authSource: text("auth_source").notNull(),
    externalUserId: text("external_user_id").notNull(),
    displayLabel: text("display_label"),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({
      name: "user_identities_pk",
      columns: [table.clientInstanceId, table.authSource, table.externalUserId]
    }),
    index("user_identities_user_idx").on(table.clientInstanceId, table.userId)
  ]
);
