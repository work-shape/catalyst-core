import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { StructuredDataResourceRecord } from "@vivd-catalyst/core";
import { conversations } from "./conversations";

export const structuredDataResources = pgTable(
  "structured_data_resources",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    resourceKey: text("resource_key").notNull(),
    title: text("title").notNull(),
    state: jsonb("state").$type<StructuredDataResourceRecord["state"]>().notNull(),
    revision: integer("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("structured_data_resources_conversation_key_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.resourceKey
    )
  ]
);
