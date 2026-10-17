import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { ClientInstanceId } from "@work-shape/catalyst-core";
import { conversations } from "./conversations";

/**
 * The Try conversation of a Build conversation and an agent (TRY-1b). The row is what hides the
 * conversation from every list, marks its usage `preview` and leads the retry of its cleanup to
 * it, so it lives as long as the conversation holds data: the cleanup after its deletion
 * removes it last. The agent is named by the id of its asset without a key: removing the agent
 * leaves its Try conversations to their Build conversation, which removes them.
 */
export const agentTryConversations = pgTable(
  "agent_try_conversations",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    buildConversationId: text("build_conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /**
     * When an open found this one deleted and made another in its place. The row stays until
     * the cleanup of its conversation is through.
     */
    replacedAt: timestamp("replaced_at", { withTimezone: true })
  },
  (table) => [
    // One current per Build conversation and agent.
    uniqueIndex("agent_try_conversations_current_idx")
      .on(table.buildConversationId, table.agentId)
      .where(sql`${table.replacedAt} is null`),
    // What a Build conversation's deletion finds its Try conversations by, replaced ones too.
    index("agent_try_conversations_build_idx").on(table.buildConversationId, table.agentId)
  ]
);
