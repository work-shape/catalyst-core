import { index, primaryKey, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ClientInstanceId } from "@vivd-catalyst/core";
import { configAssets } from "./configAssets";
import { workflowRuns } from "./workflowRuns";

/**
 * "Run live once" on one action or step of one draft revision of an App or a Workflow, for the
 * person who set it (ADR-0031): a switch that is set and not used yet. A row lives until a call
 * takes it, until it is cleared because the asset's draft is another revision now, or until the
 * asset is removed. Set again, it replaces the one its owner set before.
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
  // finds its switches through the key. One switch per part and owner.
  (table) => [
    primaryKey({
      name: "live_once_switches_owner_pk",
      columns: [table.assetId, table.part, table.switchedById]
    })
  ]
);

/**
 * The step of a Workflow test run that a switch made live, from the first call of that step in
 * the run to the end of the run (ADR-0031). The switch row is taken when this row is written, so
 * its owner can set a new switch for the next run while this one goes on. Kept as the record of
 * which run used which switch, and removed with the run or the asset.
 */
export const liveOnceRuns = pgTable(
  "live_once_runs",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    // A run's bindings go with the run.
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    part: text("part").notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    assetKind: text("asset_kind").notNull(),
    assetName: text("asset_name").notNull(),
    revisionId: text("revision_id").notNull(),
    switchedById: text("switched_by_id").notNull(),
    switchedByLabel: text("switched_by_label").notNull(),
    switchedAt: timestamp("switched_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull()
  },
  (table) => [
    // One binding per step and run: of two items that take a switch at once, one writes it.
    primaryKey({ name: "live_once_runs_pk", columns: [table.workflowRunId, table.part] }),
    // The bindings of one owner on one asset, newest first: what a page shows of their switches.
    index("live_once_runs_owner_idx").on(
      table.assetId,
      table.switchedById,
      table.part,
      table.usedAt
    )
  ]
);
