import { sql } from "drizzle-orm";
import {
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  ClientInstanceId,
  ConnectionBindingScheme,
  ConnectionBindingState,
  ConnectionHealth,
  JsonValue,
  SecretSource
} from "@work-shape/catalyst-core";
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
    /**
     * The OAuth client registered at the Connection's authorization server: issuer, client id,
     * method and time. No client secret: that is the Connection's own secret.
     */
    oauthClient: jsonb("oauth_client").$type<JsonValue>(),
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

/**
 * The sign-in of a Connection at its outside system, one per Connection and credential
 * subject. It names the secret that holds the token set and never holds a token itself. A
 * binding is used for the origin it was made for only.
 */
export const connectionBindings = pgTable(
  "connection_bindings",
  {
    connectionAssetId: text("connection_asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    /** The person a personal binding belongs to; null on a shared one. */
    userId: text("user_id"),
    state: text("state").$type<ConnectionBindingState>().notNull(),
    scheme: text("scheme").$type<ConnectionBindingScheme>().notNull(),
    accountId: text("account_id"),
    accountLabel: text("account_label"),
    grantedScopes: text("granted_scopes").array().notNull(),
    secretHandle: text("secret_handle").notNull(),
    secretVersion: integer("secret_version").notNull(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull(),
    connectedBy: text("connected_by"),
    lastUsedOn: date("last_used_on"),
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull(),
    stateChangedBy: text("state_changed_by"),
    stateReason: text("state_reason"),
    origin: text("origin").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    rowVersion: integer("row_version").notNull()
  },
  (table) => [
    primaryKey({
      name: "connection_bindings_pk",
      columns: [table.connectionAssetId, table.subject]
    }),
    index("connection_bindings_client_idx").on(table.clientInstanceId),
    check(
      "connection_bindings_state_check",
      sql`${table.state} in ('connected', 'needs_reconnect', 'revoked')`
    ),
    check("connection_bindings_scheme_check", sql`${table.scheme} in ('oauth')`),
    check("connection_bindings_row_version_check", sql`${table.rowVersion} >= 1`),
    check(
      "connection_bindings_lease_check",
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAt} is null)`
    )
  ]
);

/**
 * A sign-in under way, from its start to its callback: at most 15 minutes, used once and
 * then deleted. The state is stored as a hash and the PKCE verifier sealed with a key of the
 * Secret Store, so the row lets nobody complete the sign-in.
 */
export const connectionSetupSessions = pgTable(
  "connection_setup_sessions",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    connectionAssetId: text("connection_asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    connectionRevision: integer("connection_revision").notNull(),
    subject: text("subject").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    authSessionId: text("auth_session_id").notNull(),
    stateHash: text("state_hash").notNull(),
    verifierKeyId: text("verifier_key_id").notNull(),
    verifierNonce: bytes("verifier_nonce").notNull(),
    verifierCiphertext: bytes("verifier_ciphertext").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    issuer: text("issuer").notNull(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("connection_setup_sessions_state_idx").on(table.stateHash),
    index("connection_setup_sessions_expiry_idx").on(table.clientInstanceId, table.expiresAt),
    check(
      "connection_setup_sessions_nonce_length_check",
      sql`octet_length(${table.verifierNonce}) = 12`
    )
  ]
);
