import { foreignKey, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { ClientInstanceId, ConversationId } from "@work-shape/catalyst-core";
import { conversations } from "./conversations";
import { productUsers } from "./users";

/**
 * The people the creator of a private chat named (CHAT-SHARE): each reads and writes in the
 * chat while a member of its workspace. A row grants nothing beyond that chat. It holds ids and
 * a time only, and goes with its conversation and with the person named. The same shape as a
 * private project's named people (PRJ-10).
 */
export const conversationPeople = pgTable(
  "conversation_people",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    conversationId: text("conversation_id")
      .$type<ConversationId>()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    addedByUserId: text("added_by_user_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "conversation_people_pk",
      columns: [table.conversationId, table.userId]
    }),
    // The chats shared with a person, and the foreign key below for a removed person.
    index("conversation_people_user_idx").on(table.clientInstanceId, table.userId),
    foreignKey({
      name: "conversation_people_user_fk",
      columns: [table.clientInstanceId, table.userId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("cascade")
  ]
);
