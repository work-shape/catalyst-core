import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { ClientInstanceId } from "@work-shape/catalyst-core";
import { conversations } from "./conversations";

/** A person's private preview, retained as a cleanup marker until its data is removed. */
export const agentTryConversations = pgTable(
  "agent_try_conversations",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    buildConversationId: text("build_conversation_id").references(() => conversations.id, {
      onDelete: "cascade"
    }),
    createdByUserId: text("created_by_user_id"),
    agentId: text("agent_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /**
     * When an open found this one deleted and made another in its place. The row stays until
     * the cleanup of its conversation is through.
     */
    replacedAt: timestamp("replaced_at", { withTimezone: true })
  },
  (table) => [
    // One current per agent and person.
    uniqueIndex("agent_try_conversations_current_idx")
      .on(table.clientInstanceId, table.agentId, table.createdByUserId)
      .where(sql`${table.replacedAt} is null`),
    // Publish and Discard find every Try conversation of one agent, replaced ones too.
    index("agent_try_conversations_agent_idx").on(
      table.clientInstanceId,
      table.agentId,
      table.conversationId
    )
  ]
);
