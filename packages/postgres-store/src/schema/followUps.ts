import { pgTable, text, integer, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AgentRunAuthorization, ConversationFollowUp } from "@work-shape/catalyst-core";
import { conversations } from "./conversations";

export const conversationFollowUps = pgTable(
  "conversation_follow_ups",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").notNull(),
    text: text("text").notNull(),
    mode: text("mode").$type<ConversationFollowUp["mode"]>().notNull(),
    status: text("status").$type<ConversationFollowUp["status"]>().notNull(),
    position: integer("position").notNull(),
    agentName: text("agent_name").notNull(),
    modelBindingId: text("model_binding_id"),
    reasoningEffort: text("reasoning_effort").$type<ConversationFollowUp["reasoningEffort"]>(),
    idempotencyKey: text("idempotency_key"),
    authorizationContext: jsonb("authorization_context").$type<AgentRunAuthorization>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    dispatchedRunId: text("dispatched_run_id")
  },
  (table) => [
    uniqueIndex("conversation_follow_ups_position_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.position
    ),
    index("conversation_follow_ups_pending_idx")
      .on(table.clientInstanceId, table.conversationId, table.position)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex("conversation_follow_ups_idempotency_idx")
      .on(table.clientInstanceId, table.authorUserId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`)
  ]
);
