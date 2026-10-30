import { index, primaryKey, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ClientInstanceId } from "@work-shape/catalyst-core";
import { configAssets } from "./configAssets";

/**
 * The nonces a Workflow's `webhook` trigger accepted (EW-4), each for as long as its request's
 * timestamp would still pass. A replayed nonce meets the key; the rate of the trigger is
 * counted from `received_at`. No body and no other header is kept. A row goes with the
 * Workflow's asset.
 */
export const workflowWebhookDeliveries = pgTable(
  "workflow_webhook_deliveries",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    workflowAssetId: text("workflow_asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    nonce: text("nonce").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "workflow_webhook_deliveries_pk",
      columns: [table.workflowAssetId, table.nonce]
    }),
    // The count of the last minute and the removal of rows that are too old to pass.
    index("workflow_webhook_deliveries_received_idx").on(table.workflowAssetId, table.receivedAt)
  ]
);
