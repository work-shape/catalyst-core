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
  AssetScope,
  AuditActor,
  CollaborationWorkspace,
  ConfigAssetRecord,
  ConfigAssetRevisionOrigin,
  ConfigAssetRevisionRecord,
  FileSetId,
  JsonObject
} from "@work-shape/catalyst-core";
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
    // The owner: the instance, or the workspace `scopeId` names.
    scopeKind: text("scope_kind").$type<AssetScope["kind"]>().notNull().default("instance"),
    scopeId: text("scope_id"),
    status: text("status").$type<ConfigAssetRecord["status"]>().notNull(),
    // The draft pointer of a `draft_published` kind and the live pointer of every other.
    activeRevisionId: text("active_revision_id").notNull(),
    // The pointer the users of a `draft_published` kind are served from. Empty before the
    // first publish, and on every `active` kind.
    publishedRevisionId: text("published_revision_id"),
    // The name a person gave the asset in the interface. It stands over the title every revision
    // carries, draft and published alike, and no write of a revision changes it. Empty where no
    // person named the asset: its revisions' titles are read then.
    personTitle: text("person_title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    // A name is unique per client instance and kind whatever the scope: references are by name.
    // That also keeps it unique within one workspace, so no index per workspace is needed.
    uniqueIndex("config_assets_client_kind_name_idx").on(
      table.clientInstanceId,
      table.kind,
      table.name
    ),
    // A name prefix is a range of this index under any collation.
    index("config_assets_client_kind_name_prefix_idx").on(
      table.clientInstanceId,
      table.kind,
      table.name.op("text_pattern_ops")
    ),
    // An asset a workspace owns cannot outlive it. Nothing cascades: the workspace delete
    // removes its assets itself, with the grants on them, and this key refuses one that does not.
    foreignKey({
      name: "config_assets_scope_workspace_fk",
      columns: [table.scopeId],
      foreignColumns: [collaborationWorkspaces.id]
    }),
    // What a workspace owns, for its delete and for the key above. Instance assets are not in it.
    index("config_assets_scope_idx")
      .on(table.scopeId)
      .where(sql`${table.scopeId} is not null`),
    check("config_assets_scope_kind_check", sql`${table.scopeKind} in ('instance', 'workspace')`),
    check(
      "config_assets_scope_id_check",
      sql`(${table.scopeKind} = 'instance') = (${table.scopeId} is null)`
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
    // The immutable file set of the revision, for a kind whose revisions hold files. No
    // foreign key: whoever removes an asset removes its file sets in the same transaction.
    fileSetId: text("file_set_id").$type<FileSetId>(),
    // The commit the revision names and its tree, for an asset whose content is a repository.
    // Empty for every other.
    commit: text("commit"),
    tree: text("tree"),
    actor: jsonb("actor").$type<AuditActor>(),
    origin: jsonb("origin").$type<ConfigAssetRevisionOrigin>(),
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

/**
 * Each publish of a `draft_published` asset, numbered from 1 per asset: what members call a
 * version. A publish of an earlier revision, the way back, is a row of its own.
 */
export const configAssetPublications = pgTable(
  "config_asset_publications",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    number: integer("number").notNull(),
    actor: jsonb("actor").$type<AuditActor>(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    /** False for historical publishes whose timestamp was inferred from an edit. */
    publishedAtKnown: boolean("published_at_known").notNull().default(true),
    note: text("note")
  },
  (table) => [
    uniqueIndex("config_asset_publications_asset_number_idx").on(table.assetId, table.number)
  ]
);

/** Availability of agents, Apps, Knowledge Bases and Connections. No row grants no workspace availability. */
export const configAssetAvailability = pgTable(
  "config_asset_availability",
  {
    assetId: text("asset_id")
      .primaryKey()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").notNull(),
    mode: text("mode").$type<AgentAvailability["mode"]>().notNull(),
    personalWorkspaces: boolean("personal_workspaces").notNull().default(false),
    // A workspace's agent made by someone who may not approve its publish starts offered
    // nowhere with this set; the approval of its first publish offers it in its workspace.
    // Every later write of the availability clears it (WS-PUB-1b).
    awaitingFirstPublish: boolean("awaiting_first_publish").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("config_asset_availability_client_idx").on(table.clientInstanceId),
    check("config_asset_availability_mode_check", sql`${table.mode} in ('all', 'selected')`)
  ]
);

/**
 * The agents only holders of `agent.use` may use where they are available (AGENT-USE-1). No
 * row: everyone who may work in such a workspace uses the agent there.
 */
export const agentUseLimits = pgTable(
  "agent_use_limits",
  {
    assetId: text("asset_id")
      .primaryKey()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [index("agent_use_limits_client_idx").on(table.clientInstanceId)]
);

/**
 * The skills of a Personal Workspace its owner uses in their own chats with every agent
 * (SCOPE-MYCHATS). A row is on; no row is off. Its owner is the workspace's person, read
 * through the skill, so the row goes with the skill and with the person's workspace.
 */
export const personalChatSkills = pgTable("personal_chat_skills", {
  assetId: text("asset_id")
    .primaryKey()
    .references(() => configAssets.id, { onDelete: "cascade" }),
  clientInstanceId: text("client_instance_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

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
