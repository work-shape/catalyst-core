import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { ClientInstanceId, ConversationId } from "@work-shape/catalyst-core";
import { configAssets } from "./configAssets";
import { conversations } from "./conversations";

/**
 * The assets the agent of a conversation created (BUILD-ALL-1): beside its subject, the
 * conversation may keep saving their drafts and test them. `revision` is the revision the create
 * wrote, so an asset deleted or made anew under the name since is no longer one of them. The
 * rows go with the conversation's other data when it is deleted, and with the asset.
 */
export const conversationCreatedAssets = pgTable(
  "conversation_created_assets",
  {
    conversationId: text("conversation_id")
      .$type<ConversationId>()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    revision: integer("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "conversation_created_assets_pk",
      columns: [table.conversationId, table.assetId]
    }),
    // The key above for a removed asset.
    index("conversation_created_assets_asset_idx").on(table.assetId)
  ]
);
