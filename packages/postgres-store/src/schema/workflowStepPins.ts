import { index, primaryKey, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ClientInstanceId, WorkflowRunId } from "@work-shape/catalyst-core";
import { configAssets } from "./configAssets";
import { workflowRuns } from "./workflowRuns";

/**
 * A pinned step output of a Workflow's draft (EW-10): one person's pin of one step on the
 * output that step had in a run. It names the run and holds no value, so the output stays that
 * run's data. A row goes with the Workflow's asset and with its run; a pin whose step is no
 * longer the one it was pinned on (`step_hash`) is cleared when it is next read.
 */
export const workflowStepPins = pgTable(
  "workflow_step_pins",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    step: text("step").notNull(),
    pinnedBy: text("pinned_by").notNull(),
    sourceRunId: text("source_run_id")
      .$type<WorkflowRunId>()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepHash: text("step_hash").notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull()
  },
  // An asset id is unique on its own, and the key leads with it, so the delete of an asset
  // finds its pins through the key. One pin per step and owner.
  (table) => [
    primaryKey({
      name: "workflow_step_pins_pk",
      columns: [table.assetId, table.pinnedBy, table.step]
    }),
    // The removal of a run finds the pins that name it.
    index("workflow_step_pins_source_run_idx").on(table.sourceRunId)
  ]
);
