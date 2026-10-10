import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp
} from "drizzle-orm/pg-core";
import type {
  JsonObject,
  ModelSystemPurpose,
  ModelUsageEvent,
  ModelUsageEventStatus,
  ProviderRegion
} from "@vivd-catalyst/core";
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
    // The agent of the run. A call the product made for itself carries its purpose here too
    // for one more release, for the Usage page of the previous one; rows of the contract
    // step hold null.
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
    // A row a previous release writes names no status: its call is over when it is written.
    status: text("status").$type<ModelUsageEventStatus>().notNull().default("settled"),
    // What the row holds on the counters of its day and month: the reservation while the call
    // runs, then what it used. Null on rows written before the counters, which count as their
    // tokens and their settled cost.
    countedTokens: bigint("counted_tokens", { mode: "number" }),
    countedCostMicros: bigint("counted_cost_micros", { mode: "number" }),
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
      .where(sql`${table.collaborationWorkspaceId} is not null`),
    // What recovery finds the calls by that never settled. Holds the calls in flight only.
    index("model_usage_events_pending_idx")
      .on(table.clientInstanceId, table.createdAt)
      .where(sql`${table.status} = 'pending'`)
  ]
);

const amount = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);

/**
 * What a limit is held against: one row per scope and period, a column per metric. A row holds
 * what the calls of its period used and what the calls in flight reserved. Admission adds to it
 * with one conditional update and never reads usage events.
 */
export const modelUsageCounters = pgTable(
  "model_usage_counters",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    // `instance` today. A limit per workspace or per user adds rows of its own kind.
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    periodKind: text("period_kind").$type<"day" | "month">().notNull(),
    // The first UTC day of the period.
    periodStart: date("period_start", { mode: "string" }).notNull(),
    modelCallCount: amount("model_call_count"),
    tokens: amount("tokens"),
    costMicros: amount("cost_micros")
  },
  (table) => [
    primaryKey({
      name: "model_usage_counters_pk",
      columns: [
        table.clientInstanceId,
        table.scopeKind,
        table.scopeId,
        table.periodKind,
        table.periodStart
      ]
    })
  ]
);

/**
 * The sums the Usage page shows, kept by the transaction that ends a call: one row per UTC day,
 * model, provider, region, purpose or agent, and currency. An absent value is the empty string,
 * so the key is whole. Calls in flight are in no row.
 */
export const modelUsageDailyRollups = pgTable(
  "model_usage_daily_rollups",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    region: text("region").notNull(),
    purpose: text("purpose").notNull(),
    agentName: text("agent_name").notNull(),
    // The currency of the settled costs in the row. Empty for calls whose cost is not settled.
    currency: text("currency").notNull(),
    modelCallCount: amount("model_call_count"),
    inputTokens: amount("input_tokens"),
    cachedInputTokens: amount("cached_input_tokens"),
    outputTokens: amount("output_tokens"),
    totalTokens: amount("total_tokens"),
    webSearchCallCount: amount("web_search_call_count"),
    settledModelCallCount: amount("settled_model_call_count"),
    uncachedInputCostMicros: amount("uncached_input_cost_micros"),
    cachedInputCostMicros: amount("cached_input_cost_micros"),
    outputCostMicros: amount("output_cost_micros"),
    webSearchCostMicros: amount("web_search_cost_micros"),
    settledWebSearchCallCount: amount("settled_web_search_call_count")
  },
  (table) => [
    primaryKey({
      name: "model_usage_daily_rollups_pk",
      columns: [
        table.clientInstanceId,
        table.day,
        table.providerId,
        table.model,
        table.region,
        table.purpose,
        table.agentName,
        table.currency
      ]
    })
  ]
);

/** Where a maintenance task of the usage ledger stands, so a new process goes on from there. */
export const modelUsageMaintenance = pgTable(
  "model_usage_maintenance",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    task: text("task").notNull(),
    state: jsonb("state").$type<JsonObject>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "model_usage_maintenance_pk",
      columns: [table.clientInstanceId, table.task]
    })
  ]
);
