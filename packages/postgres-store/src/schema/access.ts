import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type { PermissionGrant } from "@vivd-catalyst/core";

/**
 * Who may do an action on a scope. `scope_id` is a workspace id or an asset id and is null for
 * instance and Namespace scope; `namespace` is a registered prefix and set only for Namespace
 * scope.
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
    namespace: text("namespace"),
    effect: text("effect").$type<PermissionGrant["effect"]>().notNull().default("allow"),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("permission_grants_unique").on(
      table.clientInstanceId,
      table.holderKind,
      table.holderId,
      table.action,
      table.scopeKind,
      sql`coalesce(${table.scopeId}, '')`,
      sql`coalesce(${table.namespace}, '')`
    ),
    index("permission_grants_holder").on(table.clientInstanceId, table.holderKind, table.holderId),
    check(
      "permission_grants_holder_kind_check",
      sql`${table.holderKind} in ('user', 'service_principal', 'role', 'group')`
    ),
    check(
      "permission_grants_scope_kind_check",
      sql`${table.scopeKind} in ('instance', 'workspace', 'namespace', 'asset')`
    ),
    check("permission_grants_effect_check", sql`${table.effect} in ('allow', 'deny')`),
    check(
      "permission_grants_namespace_check",
      sql`(${table.scopeKind} = 'namespace') = (${table.namespace} is not null)`
    ),
    check(
      "permission_grants_scope_id_check",
      sql`(${table.scopeKind} in ('workspace', 'asset')) = (${table.scopeId} is not null)`
    )
  ]
);

/** A registered name prefix, with the trailing hyphen. A null list does not restrict. */
export const namespaces = pgTable(
  "namespaces",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    prefix: text("prefix").notNull(),
    displayName: text("display_name").notNull(),
    allowedToolNames: jsonb("allowed_tool_names").$type<string[]>(),
    allowedModelBindingIds: jsonb("allowed_model_binding_ids").$type<string[]>(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ name: "namespaces_pk", columns: [table.clientInstanceId, table.prefix] })
  ]
);
