import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type { PermissionGrant, RolePendingAction } from "@work-shape/catalyst-core";

/**
 * Who may do an action on a scope. `scope_id` is a workspace id or an asset id and is null for
 * instance scope.
 */
export const permissionGrants = pgTable(
  "permission_grants",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    holderKind: text("holder_kind").$type<PermissionGrant["holderKind"]>().notNull(),
    holderId: text("holder_id").notNull(),
    action: text("action").notNull(),
    scopeKind: text("scope_kind").$type<PermissionGrant["scopeKind"]>().notNull(),
    scopeId: text("scope_id"),
    effect: text("effect").$type<PermissionGrant["effect"]>().notNull().default("allow"),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("permission_grants_scope_unique").on(
      table.clientInstanceId,
      table.holderKind,
      table.holderId,
      table.action,
      table.scopeKind,
      sql`coalesce(${table.scopeId}, '')`
    ),
    index("permission_grants_holder").on(table.clientInstanceId, table.holderKind, table.holderId),
    check(
      "permission_grants_holder_kind_check",
      sql`${table.holderKind} in ('user', 'service_principal', 'role', 'group')`
    ),
    check(
      "permission_grants_scope_kind_check",
      sql`${table.scopeKind} in ('instance', 'workspace', 'asset')`
    ),
    check("permission_grants_effect_check", sql`${table.effect} in ('allow', 'deny')`),
    check(
      "permission_grants_scope_id_check",
      sql`(${table.scopeKind} in ('workspace', 'asset')) = (${table.scopeId} is not null)`
    )
  ]
);

/**
 * A role of the instance: every custom role, and a built-in one (`user`, `admin`) from a
 * superadmin's first edit on. Its grants are rows of `permission_grants` with the role as
 * holder. A built-in role without a row holds its release default, and `superadmin` never has
 * one. `default_actions` is the default a built-in role was last reconciled with, and
 * `pending_actions` what a release changed in that default since, waiting for a decision.
 */
export const roles = pgTable(
  "roles",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    builtIn: boolean("built_in").notNull(),
    defaultActions: jsonb("default_actions").$type<string[]>(),
    pendingActions: jsonb("pending_actions").$type<RolePendingAction[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ name: "roles_pk", columns: [table.clientInstanceId, table.id] }),
    uniqueIndex("roles_name_unique").on(table.clientInstanceId, table.name),
    check("roles_built_in_check", sql`not ${table.builtIn} or ${table.id} in ('user', 'admin')`),
    check(
      "roles_default_actions_check",
      sql`${table.builtIn} = (${table.defaultActions} is not null)`
    )
  ]
);

/**
 * A row says the legacy permission lists were written back into their columns for a release
 * before AP-4 (`scripts/verify-permissions.ts --restore-legacy-columns`). The next migration
 * step moves the lists into grant rows again and empties the table.
 */
export const legacyPermissionRestores = pgTable("legacy_permission_restores", {
  restoredAt: timestamp("restored_at", { withTimezone: true }).primaryKey()
});
