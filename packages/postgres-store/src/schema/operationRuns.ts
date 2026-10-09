import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  JsonObject,
  JsonValue,
  OperationDenial,
  OperationEffect,
  OperationOrigin,
  OperationRunActor,
  OperationRunDecision,
  OperationRunError,
  OperationRunId,
  OperationRunStatus
} from "@vivd-catalyst/core";

/**
 * One row per call of a registered operation. No foreign key to `conversations`: a run of an
 * app outlives the conversation that built the app, and conversation cleanup deletes by
 * `conversation_id` instead.
 */
export const operationRuns = pgTable(
  "operation_runs",
  {
    id: text("id").$type<OperationRunId>().primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    operation: text("operation").notNull(),
    effect: text("effect").$type<OperationEffect>().notNull(),
    actorKind: text("actor_kind").$type<OperationRunActor["kind"]>().notNull(),
    actorId: text("actor_id").notNull(),
    // Minimized: kind, id, label and the delegated actor. Never scopes or an address.
    actor: jsonb("actor").$type<OperationRunActor>().notNull(),
    ownerUserId: text("owner_user_id"),
    collaborationWorkspaceId: text("collaboration_workspace_id").$type<CollaborationWorkspaceId>(),
    originKind: text("origin_kind").$type<OperationOrigin["kind"]>().notNull(),
    origin: jsonb("origin").$type<OperationOrigin>().notNull(),
    conversationId: text("conversation_id").$type<ConversationId>(),
    idempotencyKey: text("idempotency_key"),
    inputHash: text("input_hash").notNull(),
    inputRef: text("input_ref"),
    status: text("status").$type<OperationRunStatus>().notNull(),
    attempt: integer("attempt").notNull().default(1),
    decision: jsonb("decision").$type<OperationRunDecision>(),
    approvalRequestId: text("approval_request_id"),
    // The answer of a completed changing call, wrapped so that an answer of `null` is kept.
    output: jsonb("output").$type<{ value: JsonValue }>(),
    resultRef: text("result_ref"),
    // A code and a safe message, and for a refused run what refused it. Never provider text.
    error: jsonb("error").$type<OperationRunError & { denial?: OperationDenial }>(),
    usage: jsonb("usage").$type<JsonObject>(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    check("operation_runs_effect_check", sql`${table.effect} in ('reading', 'changing')`),
    check(
      "operation_runs_actor_kind_check",
      sql`${table.actorKind} in ('user', 'service_principal')`
    ),
    check(
      "operation_runs_status_check",
      sql`${table.status} in ('running', 'pending_confirmation', 'pending_approval', 'done', 'failed', 'denied', 'expired')`
    ),
    // An idempotency key belongs to its actor: nobody reads another's result by guessing one.
    uniqueIndex("operation_runs_idempotency_idx")
      .on(table.clientInstanceId, table.actorId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("operation_runs_client_created_idx").on(table.clientInstanceId, table.createdAt.desc()),
    index("operation_runs_actor_created_idx").on(
      table.clientInstanceId,
      table.actorId,
      table.createdAt.desc()
    ),
    index("operation_runs_open_idx")
      .on(table.clientInstanceId, table.status, table.expiresAt)
      .where(sql`${table.status} in ('running', 'pending_confirmation', 'pending_approval')`),
    index("operation_runs_conversation_idx")
      .on(table.clientInstanceId, table.conversationId)
      .where(sql`${table.conversationId} is not null`),
    index("operation_runs_approval_request_idx")
      .on(table.approvalRequestId)
      .where(sql`${table.approvalRequestId} is not null`)
  ]
);
