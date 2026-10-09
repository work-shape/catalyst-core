import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type { AgentRun, RunObservation, RunStartCommand } from "@vivd-catalyst/core";
import { conversations, messages } from "./conversations";

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    inputMessageId: text("input_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    agentName: text("agent_name").notNull(),
    modelBindingId: text("model_binding_id"),
    reasoningEffort: text("reasoning_effort").$type<AgentRun["reasoningEffort"]>(),
    locale: text("locale").$type<AgentRun["locale"]>(),
    authorizationContext: jsonb("authorization_context").$type<AgentRun["authorization"]>(),
    status: text("status").$type<AgentRun["status"]>().notNull(),
    idempotencyKey: text("idempotency_key"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastSequence: integer("last_sequence").notNull().default(0),
    error: jsonb("error").$type<NonNullable<AgentRun["error"]>>(),
    correlationId: text("correlation_id").notNull(),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason")
  },
  (table) => [
    uniqueIndex("agent_runs_active_conversation_idx")
      .on(table.clientInstanceId, table.conversationId)
      .where(sql`${table.status} in ('queued', 'running', 'waiting_for_permission', 'cancelling')`),
    uniqueIndex("agent_runs_idempotency_idx")
      .on(table.clientInstanceId, table.conversationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("agent_runs_conversation_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.updatedAt.desc()
    ),
    index("agent_runs_owner_created_idx").on(
      table.clientInstanceId,
      table.ownerUserId,
      table.startedAt.desc()
    ),
    index("agent_runs_queue_idx").on(table.clientInstanceId, table.status, table.startedAt.asc()),
    index("agent_runs_lease_idx").on(table.clientInstanceId, table.status, table.leaseExpiresAt)
  ]
);

export const agentRunObservations = pgTable(
  "agent_run_observations",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").$type<RunObservation["type"]>().notNull(),
    payload: jsonb("payload").$type<RunObservation["payload"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "agent_run_observations_pk",
      columns: [table.runId, table.sequence]
    }),
    index("agent_run_observations_conversation_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.runId,
      table.sequence
    ),
    index("agent_run_observations_owner_created_idx").on(
      table.clientInstanceId,
      table.ownerUserId,
      table.createdAt
    )
  ]
);

export const runStartCommands = pgTable(
  "run_start_commands",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandKind: text("command_kind").$type<RunStartCommand["commandKind"]>().notNull(),
    status: text("status").$type<RunStartCommand["status"]>().notNull(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade"
    }),
    userMessageId: text("user_message_id").references(() => messages.id, {
      onDelete: "cascade"
    }),
    runId: text("run_id").references(() => agentRuns.id, {
      onDelete: "cascade"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("run_start_commands_idempotency_idx").on(
      table.clientInstanceId,
      table.ownerUserId,
      table.commandKind,
      table.idempotencyKey
    ),
    index("run_start_commands_run_idx").on(table.clientInstanceId, table.runId)
  ]
);
