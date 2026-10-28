import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  AgentRun,
  AgentRunResumeState,
  RunObservation,
  RunStartCommand
} from "@work-shape/catalyst-core";
import { conversations, messages } from "./conversations";

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // The person the run acts for. Null only on an agent step's run, which acts as its
    // Workflow's principal (`principal_id`); exactly one of the two is set.
    ownerUserId: text("owner_user_id"),
    principalId: text("principal_id"),
    // A Child Agent Run: the run that started it, the run at the top of its tree, its depth
    // and the Operation Run of the `agents.run` call. Null on a root run.
    parentRunId: text("parent_run_id"),
    rootRunId: text("root_run_id"),
    depth: integer("depth").notNull().default(0),
    parentOperationRunId: text("parent_operation_run_id"),
    // The step run of the Workflow `agent` step that started the run.
    workflowStepRunId: text("workflow_step_run_id"),
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
    cancellationReason: text("cancellation_reason"),
    // What a run that waits for a decision keeps to go on; null otherwise (EW-2a).
    resumeState: jsonb("resume_state").$type<AgentRunResumeState>(),
    // The project the run's chat was in at its start, and the version of its AGENTS.md the
    // run took (PRJ-3); no version where the project had none. No foreign key: the record
    // outlives the project, as an id.
    projectId: text("project_id"),
    projectInstructionsVersion: integer("project_instructions_version")
  },
  (table) => [
    check(
      "agent_runs_owner_check",
      sql`(${table.ownerUserId} is null) <> (${table.principalId} is null)`
    ),
    check(
      "agent_runs_lineage_check",
      sql`(${table.parentRunId} is null and ${table.rootRunId} is null and ${table.parentOperationRunId} is null and ${table.depth} = 0) or (${table.parentRunId} is not null and ${table.rootRunId} is not null and ${table.parentOperationRunId} is not null and ${table.depth} = 1)`
    ),
    check(
      "agent_runs_started_by_check",
      sql`${table.parentOperationRunId} is null or ${table.workflowStepRunId} is null`
    ),
    uniqueIndex("agent_runs_active_conversation_idx")
      .on(table.clientInstanceId, table.conversationId)
      .where(
        sql`${table.status} in ('queued', 'running', 'waiting_for_decision', 'waiting_for_subagents', 'cancelling')`
      ),
    // A retried `agents.run` call finds the child it started, a retried agent step its run.
    uniqueIndex("agent_runs_parent_operation_idx")
      .on(table.clientInstanceId, table.parentOperationRunId)
      .where(sql`${table.parentOperationRunId} is not null`),
    uniqueIndex("agent_runs_workflow_step_idx")
      .on(table.clientInstanceId, table.workflowStepRunId)
      .where(sql`${table.workflowStepRunId} is not null`),
    index("agent_runs_parent_idx")
      .on(table.clientInstanceId, table.parentRunId)
      .where(sql`${table.parentRunId} is not null`),
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
    // What the Usage page counts the runs of a period by (LU-3).
    index("agent_runs_client_started_idx").on(table.clientInstanceId, table.startedAt),
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
    // Null on the events of an agent step's run, which acts for no person.
    ownerUserId: text("owner_user_id"),
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
