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
  JsonValue,
  OperationDenial,
  OperationEffect,
  OperationOrigin,
  OperationRunActor,
  OperationRunDecision,
  OperationRunError,
  OperationRunId,
  OperationRunStatus,
  OperationRunUsage,
  OperationTarget
} from "@work-shape/catalyst-core";

/**
 * One row per call of a registered operation. No foreign key to `conversations`: a run of an
 * app outlives the conversation that built the app. A run a conversation caused is deleted
 * with the conversation; every other run is deleted with the audit events of its age.
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
    // Where the call went (ADR-0031). A run written by a release before the column is `live`.
    target: text("target").$type<OperationTarget>().notNull().default("live"),
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
    usage: jsonb("usage").$type<OperationRunUsage>(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // When the call took its place within its operation's limits (`admitWithinLimits`), such
    // as a mail of `mail.send` within `outbound.limits`. Null for every other call.
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
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
    check("operation_runs_target_check", sql`${table.target} in ('live', 'test', 'dry_run')`),
    // An idempotency key belongs to its actor: nobody reads another's result by guessing one.
    // The kind is part of the actor, so a user and a service principal never share a key.
    uniqueIndex("operation_runs_idempotency_idx")
      .on(table.clientInstanceId, table.actorKind, table.actorId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("operation_runs_client_created_idx").on(table.clientInstanceId, table.createdAt.desc()),
    index("operation_runs_actor_created_idx").on(
      table.clientInstanceId,
      table.actorId,
      table.createdAt.desc()
    ),
    // The list of runs and its filters. Each reads the newest runs of one value in the order
    // of the list, newest first with the id as the tie-break, without sorting and without
    // walking past the runs of every other value. The columns are ascending and read
    // backwards: an index declared descending puts nulls last, which `ORDER BY ... DESC` does
    // not ask for, so PostgreSQL would sort every matching run instead.
    index("operation_runs_list_idx").on(table.clientInstanceId, table.createdAt, table.id),
    // The list as the Operations page opens it: changing calls only. A read enters the table
    // when it is refused, when it fails, or when its operation records every call, and none of
    // them enters this index.
    index("operation_runs_changing_list_idx")
      .on(table.clientInstanceId, table.createdAt, table.id)
      .where(sql`${table.effect} = 'changing'`),
    index("operation_runs_status_created_idx").on(
      table.clientInstanceId,
      table.status,
      table.createdAt,
      table.id
    ),
    index("operation_runs_operation_created_idx").on(
      table.clientInstanceId,
      table.operation,
      table.createdAt,
      table.id
    ),
    index("operation_runs_origin_created_idx").on(
      table.clientInstanceId,
      table.originKind,
      table.createdAt,
      table.id
    ),
    index("operation_runs_workspace_created_idx")
      .on(table.clientInstanceId, table.collaborationWorkspaceId, table.createdAt, table.id)
      .where(sql`${table.collaborationWorkspaceId} is not null`),
    index("operation_runs_open_idx")
      .on(table.clientInstanceId, table.status, table.expiresAt)
      .where(sql`${table.status} in ('running', 'pending_confirmation', 'pending_approval')`),
    index("operation_runs_conversation_idx")
      .on(table.clientInstanceId, table.conversationId)
      .where(sql`${table.conversationId} is not null`),
    index("operation_runs_approval_request_idx")
      .on(table.approvalRequestId)
      .where(sql`${table.approvalRequestId} is not null`),
    // The places taken within an operation's limits, read by window from the newest back.
    index("operation_runs_admitted_idx")
      .on(table.clientInstanceId, table.operation, table.admittedAt)
      .where(sql`${table.admittedAt} is not null`)
  ]
);
