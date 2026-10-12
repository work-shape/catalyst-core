import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  ClientInstanceId,
  JsonObject,
  JsonValue,
  OperationRunActor,
  OperationRunId,
  ServicePrincipalId,
  WorkflowManifest,
  WorkflowRunError,
  WorkflowRunId,
  WorkflowRunMode,
  WorkflowRunStatus,
  WorkflowStepRunId,
  WorkflowStepRunStatus,
  WorkflowStepType,
  WorkflowTriggerKind
} from "@vivd-catalyst/core";

/**
 * One row per run of a Workflow. It keeps the definition it executes, so a run that a worker
 * picks up again after a restart never reads a newer one.
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").$type<WorkflowRunId>().primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    workflow: text("workflow").notNull(),
    revision: text("revision").notNull(),
    mode: text("mode").$type<WorkflowRunMode>().notNull(),
    trigger: text("trigger").$type<WorkflowTriggerKind>().notNull(),
    status: text("status").$type<WorkflowRunStatus>().notNull(),
    definition: jsonb("definition").$type<WorkflowManifest>().notNull(),
    input: jsonb("input").$type<JsonObject>().notNull(),
    // The run's result, wrapped so that a result of `null` is kept.
    output: jsonb("output").$type<{ value: JsonValue }>(),
    // A code of the engine and a sentence that may be shown. Never a value of the run.
    error: jsonb("error").$type<WorkflowRunError>(),
    principalId: text("principal_id").$type<ServicePrincipalId>().notNull(),
    principalLabel: text("principal_label").notNull(),
    // Minimized: kind, id and label of who started the run.
    startedBy: jsonb("started_by").$type<OperationRunActor>().notNull(),
    operationRunId: text("operation_run_id").$type<OperationRunId>(),
    stepRunCount: integer("step_run_count").notNull().default(0),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [
    check("workflow_runs_mode_check", sql`${table.mode} in ('live', 'test')`),
    check(
      "workflow_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'limit_reached')`
    ),
    // A constraint and not an index, so that the table has it before a row refers to it.
    unique("workflow_runs_client_id_key").on(table.clientInstanceId, table.id),
    // The runs of one Workflow, newest first. Ascending and read backwards: see
    // `operation_runs_list_idx`.
    index("workflow_runs_workflow_list_idx").on(
      table.clientInstanceId,
      table.workflow,
      table.createdAt,
      table.id
    )
  ]
);

/** One row per step a run reached, and inside a loop one per step and item. */
export const workflowStepRuns = pgTable(
  "workflow_step_runs",
  {
    id: text("id").$type<WorkflowStepRunId>().primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    runId: text("run_id").$type<WorkflowRunId>().notNull(),
    stepId: text("step_id").notNull(),
    stepType: text("step_type").$type<WorkflowStepType>().notNull(),
    key: text("key").notNull(),
    parentStepRunId: text("parent_step_run_id").$type<WorkflowStepRunId>(),
    iteration: integer("iteration"),
    // What the loop's `itemLabel` field holds for the item, cut by the engine.
    iterationLabel: text("iteration_label"),
    status: text("status").$type<WorkflowStepRunStatus>().notNull(),
    attempt: integer("attempt").notNull().default(0),
    // Set for a loop alone: `{ items }`, the list it runs over.
    input: jsonb("input").$type<{ items: JsonValue[] }>(),
    // The step's output, wrapped so that an output of `null` is kept.
    output: jsonb("output").$type<{ value: JsonValue }>(),
    operationRunId: text("operation_run_id").$type<OperationRunId>(),
    error: jsonb("error").$type<WorkflowRunError>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [
    check(
      "workflow_step_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled')`
    ),
    check(
      "workflow_step_runs_iteration_check",
      sql`(${table.parentStepRunId} is null) = (${table.iteration} is null)`
    ),
    foreignKey({
      name: "workflow_step_runs_run_fk",
      columns: [table.clientInstanceId, table.runId],
      foreignColumns: [workflowRuns.clientInstanceId, workflowRuns.id]
    }).onDelete("cascade"),
    // One step run per place of a run: a step is never started twice for the same item.
    uniqueIndex("workflow_step_runs_key_idx").on(table.runId, table.key),
    // The step runs of a run in the order they were created.
    index("workflow_step_runs_list_idx").on(table.runId, table.createdAt, table.id),
    // The results of a loop, by item, and the step an inner step refers to.
    index("workflow_step_runs_parent_idx")
      .on(table.parentStepRunId, table.stepId, table.iteration)
      .where(sql`${table.parentStepRunId} is not null`)
  ]
);
