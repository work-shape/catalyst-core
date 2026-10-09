import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
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
  AgentAvailability,
  AuditActor,
  CollaborationWorkspace,
  ConfigAssetRecord,
  ConfigAssetRevisionRecord,
  JsonObject
} from "@vivd-catalyst/core";
import { collaborationWorkspaces } from "./workspaces";

export const configAssetState = pgTable("config_asset_state", {
  clientInstanceId: text("client_instance_id").primaryKey(),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  defaultAgentName: text("default_agent_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const configAssets = pgTable(
  "config_assets",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    kind: text("kind").$type<ConfigAssetRecord["kind"]>().notNull(),
    name: text("name").notNull(),
    status: text("status").$type<ConfigAssetRecord["status"]>().notNull(),
    activeRevisionId: text("active_revision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("config_assets_client_kind_name_idx").on(
      table.clientInstanceId,
      table.kind,
      table.name
    )
  ]
);

export const configAssetRevisions = pgTable(
  "config_asset_revisions",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    operation: text("operation").$type<ConfigAssetRevisionRecord["operation"]>().notNull(),
    config: jsonb("config").$type<JsonObject>(),
    actor: jsonb("actor").$type<AuditActor>(),
    origin: jsonb("origin").$type<ConfigAssetRevisionRecord["origin"]>(),
    globalVersion: bigint("global_version", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("config_asset_revisions_asset_revision_idx").on(table.assetId, table.revision),
    index("config_asset_revisions_client_asset_revision_idx").on(
      table.clientInstanceId,
      table.assetId,
      table.revision.desc()
    )
  ]
);

/** One row per active agent asset. An agent without a row is hidden everywhere. */
export const configAssetAvailability = pgTable(
  "config_asset_availability",
  {
    assetId: text("asset_id")
      .primaryKey()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").notNull(),
    mode: text("mode").$type<AgentAvailability["mode"]>().notNull(),
    personalWorkspaces: boolean("personal_workspaces").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("config_asset_availability_client_idx").on(table.clientInstanceId),
    check("config_asset_availability_mode_check", sql`${table.mode} in ('all', 'selected')`)
  ]
);

export const configAssetWorkspaceAvailability = pgTable(
  "config_asset_workspace_availability",
  {
    assetId: text("asset_id").notNull(),
    collaborationWorkspaceId: text("collaboration_workspace_id")
      .$type<CollaborationWorkspace["id"]>()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "config_asset_workspace_availability_pk",
      columns: [table.assetId, table.collaborationWorkspaceId]
    }),
    foreignKey({
      name: "config_asset_workspace_availability_asset_fk",
      columns: [table.assetId],
      foreignColumns: [configAssetAvailability.assetId]
    }).onDelete("cascade"),
    foreignKey({
      name: "config_asset_workspace_availability_workspace_fk",
      columns: [table.collaborationWorkspaceId],
      foreignColumns: [collaborationWorkspaces.id]
    }).onDelete("cascade"),
    index("config_asset_workspace_availability_workspace_idx").on(table.collaborationWorkspaceId)
  ]
);
