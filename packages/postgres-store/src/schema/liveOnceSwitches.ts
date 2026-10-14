import { primaryKey, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ClientInstanceId } from "@vivd-catalyst/core";
import { configAssets } from "./configAssets";

/**
 * "Run live once" on one action or step of one draft revision of an App or a Workflow, for the
 * person who set it (ADR-0031). A row lives until an App call takes it, until it is cleared
 * unused because the asset's draft is another revision now, until its owner sets it again, or
 * until the asset is removed. A Workflow test run binds the row to itself instead of taking
 * it, and the row then says which run used it and when.
 */
export const liveOnceSwitches = pgTable(
  "live_once_switches",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    assetKind: text("asset_kind").notNull(),
    assetName: text("asset_name").notNull(),
    part: text("part").notNull(),
    revisionId: text("revision_id").notNull(),
    switchedById: text("switched_by_id").notNull(),
    switchedByLabel: text("switched_by_label").notNull(),
    switchedAt: timestamp("switched_at", { withTimezone: true }).notNull(),
    usedByRunId: text("used_by_run_id"),
    usedAt: timestamp("used_at", { withTimezone: true })
  },
  // An asset id is unique on its own, and the key leads with it, so the delete of an asset
  // finds its switches through the key. One switch per part and owner.
  (table) => [
    primaryKey({
      name: "live_once_switches_owner_pk",
      columns: [table.assetId, table.part, table.switchedById]
    })
  ]
);
