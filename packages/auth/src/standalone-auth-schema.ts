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

export const authUsers = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull()
});

export const authSessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" })
  },
  (table) => [index("session_user_id_idx").on(table.userId)]
);

export const authAccounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull()
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_account_provider_idx").on(table.accountId, table.providerId)
  ]
);

export const authVerifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull()
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

export const standaloneAuthProfiles = pgTable(
  "standalone_auth_profiles",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    authUserId: text("auth_user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    externalUserId: text("external_user_id").notNull(),
    displayLabel: text("display_label").notNull(),
    roles: jsonb("roles").$type<string[]>().notNull(),
    permissionRefs: jsonb("permission_refs").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "standalone_auth_profiles_pk",
      columns: [table.clientInstanceId, table.authUserId]
    }),
    uniqueIndex("standalone_auth_profiles_external_user_idx").on(
      table.clientInstanceId,
      table.externalUserId
    )
  ]
);

export const standaloneAuthSchema = {
  user: authUsers,
  session: authSessions,
  account: authAccounts,
  verification: authVerifications,
  standaloneAuthProfiles
};
