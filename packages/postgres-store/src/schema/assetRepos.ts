import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type { AssetRepoBundle, ClientInstanceId, ConversationId } from "@vivd-catalyst/core";
import { configAssets } from "./configAssets";
import { conversations } from "./conversations";

/**
 * The ledger of the repository of an asset: which bundles make it, in which order. The bytes
 * are in the object store under `objectKey`. A row is written in the transaction that writes
 * the revision its tip commit belongs to, so no row exists without a revision. The rows go
 * with their asset; whoever removes an asset removes the objects after it.
 */
export const assetRepoBundles = pgTable(
  "asset_repo_bundles",
  {
    assetId: text("asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    objectKey: text("object_key").notNull(),
    kind: text("kind").$type<AssetRepoBundle["kind"]>().notNull(),
    tipCommit: text("tip_commit").notNull(),
    prerequisiteCommit: text("prerequisite_commit"),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({ name: "asset_repo_bundles_pk", columns: [table.assetId, table.sequence] }),
    // A key is written once: two rows never name the same object.
    uniqueIndex("asset_repo_bundles_object_key_idx").on(table.objectKey),
    check("asset_repo_bundles_kind_check", sql`${table.kind} in ('full', 'incremental')`),
    check(
      "asset_repo_bundles_prerequisite_check",
      sql`(${table.kind} = 'full') = (${table.prerequisiteCommit} is null)`
    )
  ]
);

/**
 * The folder of a conversation that holds the files of an asset's repository, with the commit
 * and the revision it was written from. The row holds no bytes and goes with its conversation
 * and with its asset.
 */
export const assetCheckouts = pgTable(
  "asset_checkouts",
  {
    conversationId: text("conversation_id")
      .$type<ConversationId>()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    folder: text("folder").notNull(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    baseCommit: text("base_commit").notNull(),
    baseRevision: integer("base_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({ name: "asset_checkouts_pk", columns: [table.conversationId, table.folder] }),
    // The foreign key to the asset, for its delete.
    index("asset_checkouts_asset_idx").on(table.assetId)
  ]
);
