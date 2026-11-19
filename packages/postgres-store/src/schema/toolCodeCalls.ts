import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type {
  ClientInstanceId,
  ConversationId,
  JsonObject,
  ToolCodeCallAnswer,
  ToolCodeCallOutcome,
  ToolCodeCallRequest
} from "@work-shape/catalyst-core";
import { conversations } from "./conversations";

/**
 * One call of a code tool while it runs (TOOL-2b): the agent's input for the command worker,
 * and how the handler ended for the operation that waits. The worker clears the input with
 * the outcome; the operation removes the row once it read it; the worker's sweep removes a row
 * nobody read. The row goes with its conversation. While the handler runs it carries the one
 * request the handler made of a Connection, and its answer (TOOL-2c).
 */
export const toolCodeCalls = pgTable(
  "tool_code_calls",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    conversationId: text("conversation_id")
      .$type<ConversationId>()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    revisionId: text("revision_id").notNull(),
    input: jsonb("input").$type<JsonObject>().notNull(),
    timeoutSeconds: integer("timeout_seconds").notNull(),
    outcome: jsonb("outcome").$type<ToolCodeCallOutcome>(),
    // The handler's request to a Connection and its answer (TOOL-2c), cleared with the outcome.
    request: jsonb("request").$type<ToolCodeCallRequest>(),
    answer: jsonb("answer").$type<ToolCodeCallAnswer>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // When a worker started the handler's container: the operation's wait counts from here.
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [
    // The removal of a conversation finds its calls; the sweep finds the old ones.
    index("tool_code_calls_conversation_idx").on(table.conversationId),
    index("tool_code_calls_created_idx").on(table.clientInstanceId, table.createdAt)
  ]
);
