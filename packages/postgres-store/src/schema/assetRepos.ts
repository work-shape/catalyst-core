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
import type {
  AssetRepoBundle,
  AssetRepoSave,
  ClientInstanceId,
  ConversationId,
  OperationRunId
} from "@vivd-catalyst/core";
import { configAssets } from "./configAssets";
import { conversations } from "./conversations";

/**
 * The ledger of the repository of an asset: which bundles make it, in which order. The bytes
 * are in the object store under `objectKey`.
 *
 * A row starts as `pending`: a save writes it, in a transaction of its own, before it puts the
 * object, with the time the commit of the save carries. A save that is tried again under the
 * same Operation Run reads that time and so builds the same commit. The transaction that
 * writes the revision makes the row `live` and gives it its place in the order. A row that
 * stays `pending` is the trace of a save that did not finish; the sweeper removes its object
 * and then the row. The object store is never listed.
 *
 * The rows hold no key to the asset: the pending row of the first save is written before the
 * asset is. Whoever removes an asset removes its rows, and the objects below its prefix.
 */
export const assetRepoBundles = pgTable(
  "asset_repo_bundles",
  {
    assetId: text("asset_id").notNull(),
    operationRunId: text("operation_run_id").$type<OperationRunId>().notNull(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    state: text("state").$type<AssetRepoSave["state"]>().notNull(),
    /** The time of the save, in whole seconds: the time its commit carries. */
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull(),
    /** The place of a live row in the order of the repository. */
    sequence: integer("sequence"),
    objectKey: text("object_key"),
    kind: text("kind").$type<AssetRepoBundle["kind"]>(),
    tipCommit: text("tip_commit"),
    prerequisiteCommit: text("prerequisite_commit"),
    bytes: bigint("bytes", { mode: "number" }),
    sha256: text("sha256"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "asset_repo_bundles_pk",
      columns: [table.assetId, table.operationRunId]
    }),
    uniqueIndex("asset_repo_bundles_sequence_idx").on(table.assetId, table.sequence),
    // Two rows never name the same object.
    uniqueIndex("asset_repo_bundles_object_key_idx").on(table.objectKey),
    // What the sweeper reads: the saves that did not finish, oldest first.
    index("asset_repo_bundles_pending_idx")
      .on(table.savedAt)
      .where(sql`${table.state} = 'pending'`),
    check("asset_repo_bundles_state_check", sql`${table.state} in ('pending', 'live')`),
    // A live row has its place and its bundle; a pending one has no place yet.
    check(
      "asset_repo_bundles_live_check",
      sql`(${table.state} = 'live') = (${table.sequence} is not null) and (${table.state} = 'pending' or ${table.objectKey} is not null)`
    ),
    // A bundle is named whole or not at all.
    check(
      "asset_repo_bundles_named_check",
      sql`num_nonnulls(${table.objectKey}, ${table.kind}, ${table.tipCommit}, ${table.bytes}, ${table.sha256}) in (0, 5)`
    ),
    check("asset_repo_bundles_kind_check", sql`${table.kind} in ('full', 'incremental')`),
    check(
      "asset_repo_bundles_prerequisite_check",
      sql`${table.kind} is null or (${table.kind} = 'full') = (${table.prerequisiteCommit} is null)`
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
