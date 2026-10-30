import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import type { ClientInstanceId, PolicyValue } from "@work-shape/catalyst-core";
import { collaborationWorkspaces } from "./workspaces";

/**
 * An admin's central policy value for one operation or name pattern (OP-2), narrowed to a
 * workspace, an asset kind, both or neither. No row is the default of the operation. A row
 * narrowed to a workspace goes with the workspace.
 */
export const centralPolicySettings = pgTable(
  "central_policy_settings",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    operation: text("operation").notNull(),
    workspaceId: text("workspace_id").references(() => collaborationWorkspaces.id, {
      onDelete: "cascade"
    }),
    assetKind: text("asset_kind"),
    value: text("value").$type<PolicyValue>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    // One value per operation and narrowing; "every workspace" and "every kind" are one each.
    unique("central_policy_settings_scope_unique")
      .on(table.clientInstanceId, table.operation, table.workspaceId, table.assetKind)
      .nullsNotDistinct(),
    check(
      "central_policy_settings_value_check",
      sql`${table.value} in ('allow', 'confirm', 'approval', 'deny')`
    )
  ]
);

/** An operation or pattern whose "Always allow" an admin locked on Instance > Policies (OP-2). */
export const alwaysAllowLocks = pgTable(
  "always_allow_locks",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    operation: text("operation").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [primaryKey({ columns: [table.clientInstanceId, table.operation] })]
);
