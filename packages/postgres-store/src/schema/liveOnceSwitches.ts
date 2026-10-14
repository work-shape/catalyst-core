import { primaryKey, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ClientInstanceId } from "@vivd-catalyst/core";
import { configAssets } from "./configAssets";

/**
 * "Run live once" on one action or step of one draft revision of an App or a Workflow
 * (ADR-0031). A row lives until a call takes it, until it is cleared because the asset's
 * draft is another revision now, or until the asset is removed.
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
    switchedAt: timestamp("switched_at", { withTimezone: true }).notNull()
  },
  // An asset id is unique on its own, and the key leads with it, so the delete of an asset
  // finds its switches through the key.
  (table) => [primaryKey({ name: "live_once_switches_pk", columns: [table.assetId, table.part] })]
);
