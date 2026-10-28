import { foreignKey, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { ClientInstanceId, ConversationId } from "@work-shape/catalyst-core";
import { configAssets } from "./configAssets";
import { conversations } from "./conversations";
import { productUsers } from "./users";

/**
 * The Data Stores a person added to a conversation for reading (STORE-USE-1): beside its
 * subject, the conversation's agents are offered each store's read tools. A row grants no
 * right; every call still asks the person's `data_store.read`. It holds ids and a time only,
 * and goes with its conversation, its store and the person who added it.
 */
export const conversationDataStores = pgTable(
  "conversation_data_stores",
  {
    conversationId: text("conversation_id")
      .$type<ConversationId>()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    storeAssetId: text("store_asset_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    addedByUserId: text("added_by_user_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "conversation_data_stores_pk",
      columns: [table.conversationId, table.storeAssetId]
    }),
    // The foreign keys below and above for a removed store or person.
    index("conversation_data_stores_store_idx").on(table.storeAssetId),
    index("conversation_data_stores_added_by_idx").on(table.clientInstanceId, table.addedByUserId),
    foreignKey({
      name: "conversation_data_stores_added_by_fk",
      columns: [table.clientInstanceId, table.addedByUserId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("cascade")
  ]
);
