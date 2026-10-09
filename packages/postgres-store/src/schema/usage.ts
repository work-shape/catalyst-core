import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ModelUsageEvent } from "@vivd-catalyst/core";

export const modelUsageEvents = pgTable(
  "model_usage_events",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    agentRunId: text("agent_run_id").notNull(),
    agentName: text("agent_name").notNull(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens"),
    outputTokens: integer("output_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    webSearchCallCount: integer("web_search_call_count").notNull().default(0),
    fastMode: boolean("fast_mode").notNull().default(false),
    providerServiceTier: text("provider_service_tier"),
    source: text("source").$type<ModelUsageEvent["source"]>().notNull(),
    customerBillableCost:
      jsonb("customer_billable_cost").$type<ModelUsageEvent["customerBillableCost"]>(),
    // Who the usage is attributed to. Rows written before these columns hold none.
    userId: text("user_id"),
    collaborationWorkspaceId: text("collaboration_workspace_id"),
    operationRunId: text("operation_run_id"),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("model_usage_events_client_created_idx").on(
      table.clientInstanceId,
      table.createdAt.desc()
    )
  ]
);
