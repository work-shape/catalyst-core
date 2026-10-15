import { sql } from "drizzle-orm";
import {
  bigint,
  check,
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
  AssetRepoBundle,
  AssetRepoCommitRequest,
  AssetRepoCommitResult,
  AssetRepoSave,
  ClientInstanceId,
  ConversationId,
  OperationRunId
} from "@work-shape/catalyst-core";
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
 * stays `pending` is the trace of a save that did not finish. The sweeper makes it `swept`,
 * which is final: a swept row never becomes part of a repository, so its object may be removed
 * at any time afterwards, and is, before the row goes. The object store is never listed.
 *
 * The rows hold no key to the asset: the pending row of the first save is written before the
 * asset is. Removing an asset makes its rows `swept`, so each of its objects is removed by its
 * row, whatever becomes of the process that removed the asset.
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
    /** When the row was given up. Its object is removed from then on, and the row a day later. */
    sweptAt: timestamp("swept_at", { withTimezone: true }),
    /** What the save commits, where a worker builds its commit. No bytes. */
    request: jsonb("request").$type<AssetRepoCommitRequest>(),
    /** How the commit of the save ended. */
    result: jsonb("result").$type<AssetRepoCommitResult>(),
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
    // What the sweeper reads: the saves that did not finish and the rows it gave up.
    index("asset_repo_bundles_unfinished_idx")
      .on(table.state, table.savedAt)
      .where(sql`${table.state} <> 'live'`),
    check("asset_repo_bundles_state_check", sql`${table.state} in ('pending', 'live', 'swept')`),
    // A live row has its place and its bundle; no other row has a place.
    check(
      "asset_repo_bundles_live_check",
      sql`(${table.state} = 'live') = (${table.sequence} is not null) and (${table.state} <> 'live' or ${table.objectKey} is not null)`
    ),
    check(
      "asset_repo_bundles_swept_check",
      sql`(${table.state} = 'swept') = (${table.sweptAt} is not null)`
    ),
    // A bundle is named whole or not at all.
    check(
      "asset_repo_bundles_named_check",
      sql`num_nonnulls(${table.objectKey}, ${table.kind}, ${table.tipCommit}, ${table.bytes}, ${table.sha256}) in (0, 5)`
    ),
    check("asset_repo_bundles_kind_check", sql`${table.kind} in ('full', 'incremental')`),
    // What the rows say of a bundle is read back as such: ids and a hash in lower-case hex.
    check(
      "asset_repo_bundles_format_check",
      sql`${table.tipCommit} ~ '^[0-9a-f]{40}$' and ${table.prerequisiteCommit} ~ '^[0-9a-f]{40}$' and ${table.sha256} ~ '^[0-9a-f]{64}$' and ${table.bytes} > 0`
    ),
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
