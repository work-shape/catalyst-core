import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp
} from "drizzle-orm/pg-core";
import type { ModelSystemPurpose, ModelUsageEvent, ProviderRegion } from "@vivd-catalyst/core";
import { productUsers } from "./users";
import { collaborationWorkspaces } from "./workspaces";

export const modelUsageEvents = pgTable(
  "model_usage_events",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    // Null for a call the product made for itself: such a call has no run, and a conversation
    // only when one caused it.
    conversationId: text("conversation_id"),
    agentRunId: text("agent_run_id"),
    // The agent of the run. Null for a call the product made for itself, which has a purpose.
    agentName: text("agent_name"),
    purpose: text("purpose").$type<ModelSystemPurpose>(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    // Null for a provider inside the instance, and on rows written before the column.
    region: text("region").$type<ProviderRegion>(),
    bindingId: text("binding_id"),
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
    // Who the usage is attributed to. Rows written before these columns hold none. The amounts
    // outlive the user and the workspace: the database clears the reference when either goes.
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
    ),
    foreignKey({
      name: "model_usage_events_user_fk",
      columns: [table.userId],
      foreignColumns: [productUsers.id]
    }).onDelete("set null"),
    foreignKey({
      name: "model_usage_events_workspace_fk",
      columns: [table.collaborationWorkspaceId],
      foreignColumns: [collaborationWorkspaces.id]
    }).onDelete("set null"),
    // What the deletion of an account or a workspace finds its usage events by.
    index("model_usage_events_user_idx")
      .on(table.userId)
      .where(sql`${table.userId} is not null`),
    index("model_usage_events_workspace_idx")
      .on(table.collaborationWorkspaceId)
      .where(sql`${table.collaborationWorkspaceId} is not null`)
  ]
);
