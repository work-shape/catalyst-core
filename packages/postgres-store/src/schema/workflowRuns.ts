import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
  OperationEffect,
  OperationRunActor,
  OperationRunId,
  OperationTarget,
  ServicePrincipalId,
  UserId,
  WorkflowManifest,
  WorkflowDatasetReference,
  WorkflowCodeOutcome,
  WorkflowRunBounds,
  WorkflowRunError,
  WorkflowStagedCode,
  WorkflowStepRunLog,
  WorkflowRunId,
  WorkflowRunMode,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepRunId,
  WorkflowStepRunStatus,
  WorkflowTriggerKind
} from "@work-shape/catalyst-core";

/**
 * One row per run of a Workflow. It keeps the definition it executes and the id of that
 * revision, so a run that a worker picks up again after a restart never reads a newer one.
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").$type<WorkflowRunId>().primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    workflow: text("workflow").notNull(),
    definitionRevisionId: text("definition_revision_id").notNull(),
    mode: text("mode").$type<WorkflowRunMode>().notNull(),
    trigger: text("trigger").$type<WorkflowTriggerKind>().notNull(),
    status: text("status").$type<WorkflowRunStatus>().notNull(),
    empty: boolean("empty").notNull().default(false),
    definition: jsonb("definition").$type<WorkflowManifest>(),
    input: jsonb("input").$type<JsonObject>().notNull(),
    checkpoint:
      jsonb("checkpoint").$type<import("@work-shape/catalyst-core").NewWorkflowRun["checkpoint"]>(),
    // The run's result, wrapped so that a result of `null` is kept.
    output: jsonb("output").$type<{ value: JsonValue }>(),
    // A code of the engine and a sentence that may be shown. Never a value of the run.
    error: jsonb("error").$type<WorkflowRunError>(),
    principalId: text("principal_id").$type<ServicePrincipalId>().notNull(),
    // The name the definition gives under `runAs`. A step reads the principal by it.
    principalName: text("principal_name").notNull(),
    principalLabel: text("principal_label").notNull(),
    // Minimized: kind, id and label of who started the run.
    startedBy: jsonb("started_by").$type<OperationRunActor>().notNull(),
    operationRunId: text("operation_run_id").$type<OperationRunId>(),
    parentRunId: text("parent_run_id").$type<WorkflowRunId>(),
    parentStepRunId: text("parent_step_run_id").$type<WorkflowStepRunId>(),
    rootRunId: text("root_run_id").$type<WorkflowRunId>(),
    depth: integer("depth").notNull().default(0),
    itemIndex: integer("item_index"),
    itemLabel: text("item_label"),
    // Nullable for runs finalized before this count existed. Written only by endRun.
    failedItemCount: integer("failed_item_count"),
    stepRunCount: integer("step_run_count").notNull().default(0),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    // The bounds the run was opened under: its Workflow's limits within the ceilings. A run
    // an earlier release opens gets that release's constants and no concurrency.
    limits: jsonb("limits")
      .$type<WorkflowRunBounds>()
      .notNull()
      .default(sql`'{"durationMs":43200000,"stepRuns":20000,"loopItems":10000}'::jsonb`),
    // Since when every open step of the run waits for something outside it. Null while it works.
    waitingSince: timestamp("waiting_since", { withTimezone: true }),
    // The milliseconds the run spent waiting, which its deadline moved by.
    waitedMs: bigint("waited_ms", { mode: "number" }).notNull().default(0),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Set by a cancel that ended the run: the person, where a person cancelled, and the moment.
    cancelledBy: text("cancelled_by").$type<UserId>(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // The due time of the schedule that started the run. Null on every other run.
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    // The run key a start gave the run (EW-13k). Text of a person or a step, never in an audit.
    runKey: text("run_key"),
    labels: jsonb("labels").$type<Record<string, string>>(),
    continuation: jsonb("continuation").$type<{
      rootRunId: WorkflowRunId;
      previousRunId?: WorkflowRunId;
      successorRunId?: WorkflowRunId;
      number: number;
    }>(),
    // When the run's values and those of its step runs were removed. Null while it has them.
    dataPrunedAt: timestamp("data_pruned_at", { withTimezone: true }),
    // Version of the retention owner that cleared this run. Older marked rows need repair.
    dataPruneVersion: integer("data_prune_version").notNull().default(0)
  },
  (table) => [
    uniqueIndex("workflow_runs_operation_idx").on(table.clientInstanceId, table.operationRunId),
    uniqueIndex("workflow_runs_active_parent_step_idx")
      .on(table.clientInstanceId, table.parentStepRunId)
      .where(sql`${table.status} <> 'continued'`),
    // API projections visit only failure-bearing runs in the requested trees.
    index("workflow_runs_failures_idx")
      .on(table.clientInstanceId, table.rootRunId)
      .where(sql`${table.status} in ('failed', 'limit_reached') or ${table.failedItemCount} > 0`),
    index("workflow_runs_parent_idx").on(table.clientInstanceId, table.parentRunId),
    check("workflow_runs_depth_check", sql`${table.depth} between 0 and 2`),
    check(
      "workflow_runs_lineage_check",
      sql`(${table.parentRunId} is null and ${table.parentStepRunId} is null and ${table.depth} = 0) or (${table.parentRunId} is not null and ${table.parentStepRunId} is not null and ${table.rootRunId} is not null and ${table.depth} > 0)`
    ),
    check("workflow_runs_mode_check", sql`${table.mode} in ('live', 'test')`),
    check(
      "workflow_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'limit_reached', 'continued')`
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
    ),
    // One run per Workflow and due time of its schedule: a due time that is fired a second
    // time, by another worker or after a restart, starts nothing.
    uniqueIndex("workflow_runs_scheduled_for_idx")
      .on(table.clientInstanceId, table.workflow, table.scheduledFor)
      .where(sql`${table.scheduledFor} is not null`),
    // A run key exists once per Workflow and mode among the runs that are open or `done`: a
    // start that meets it starts nothing and is answered that run. A run that ended `failed`,
    // `cancelled` or `limit_reached` leaves the index and so gives its key up.
    uniqueIndex("workflow_runs_active_run_key_idx")
      .on(table.clientInstanceId, table.workflow, table.mode, table.runKey)
      .where(
        sql`${table.runKey} is not null and ${table.status} not in ('failed', 'cancelled', 'limit_reached', 'continued')`
      ),
    // Pending normal pruning and repair share one bounded, indexed queue.
    index("workflow_runs_retention_idx")
      .on(table.clientInstanceId, table.finishedAt, table.id)
      .where(sql`${table.dataPruneVersion} < 1 and ${table.finishedAt} is not null`),
    // Kept for the previous release while its workers drain.
    index("workflow_runs_data_prune_idx")
      .on(table.clientInstanceId, table.finishedAt)
      .where(sql`${table.dataPrunedAt} is null and ${table.finishedAt} is not null`)
  ]
);

/**
 * One row per step a run reached, and inside a loop one per step and item. It is what a run is
 * taken up again from: a row exists once per run and path (`key`), so a worker that starts
 * after another died finds what ended and starts nothing of it again.
 */
export const workflowStepRuns = pgTable(
  "workflow_step_runs",
  {
    id: text("id").$type<WorkflowStepRunId>().primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    runId: text("run_id").$type<WorkflowRunId>().notNull(),
    stepId: text("step_id").notNull(),
    stepType: text("step_type").$type<WorkflowStep["type"]>().notNull(),
    key: text("key").notNull(),
    // The step run of the block that holds the step, and the branch of that block.
    containerStepRunId: text("container_step_run_id").$type<WorkflowStepRunId>(),
    branch: text("branch"),
    iteration: integer("iteration"),
    // What the loop's `itemLabel` field holds for the item, cut by the engine.
    iterationLabel: text("iteration_label"),
    status: text("status").$type<WorkflowStepRunStatus>().notNull(),
    attempt: integer("attempt").notNull().default(0),
    // Set for a loop alone: `{ items, last }`, the list it runs over and the id of its last step.
    input: jsonb("input").$type<{
      items?: JsonValue[];
      dataset?: WorkflowDatasetReference;
      total?: number;
      last?: string;
      first?: string;
      started?: number;
      ended?: number;
    }>(),
    // The step's output, wrapped so that an output of `null` is kept.
    output: jsonb("output").$type<{ value: JsonValue }>(),
    operationRunId: text("operation_run_id").$type<OperationRunId>(),
    // Of an `agent` step: the Agent Run the step waits for.
    agentRunId: text("agent_run_id"),
    // Of a `workflow` step whose start a run key answered: the run it waits for and does not own.
    linkedRunId: text("linked_run_id").$type<WorkflowRunId>(),
    // Of an operation step: what its operation does and the name of what it belongs to.
    effect: text("effect").$type<OperationEffect>(),
    source: text("source"),
    // Where its call went (ADR-0031): `live`, `test`, or `dry_run` for a simulated step of a
    // test run. Missing on a step run a release before EW-5t wrote.
    target: text("target").$type<OperationTarget>(),
    // Of a step of a test run: what a run of the published revision would ask for here, where
    // the tester's start satisfied a `confirm` (EW-5t). Only `approval`.
    publishedWouldAsk: text("published_would_ask").$type<"approval">(),
    // Of a code step: what its container is given while it waits for the sandbox, how its
    // script ended before the engine has read that, and what the script wrote beside its result.
    staged: jsonb("staged").$type<WorkflowStagedCode>(),
    codeOutcome: jsonb("code_outcome").$type<WorkflowCodeOutcome>(),
    log: jsonb("log").$type<WorkflowStepRunLog>(),
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
      "workflow_step_runs_target_check",
      sql`${table.target} is null or ${table.target} in ('live', 'test', 'dry_run')`
    ),
    check(
      "workflow_step_runs_published_would_ask_check",
      sql`${table.publishedWouldAsk} is null or ${table.publishedWouldAsk} = 'approval'`
    ),
    check(
      "workflow_step_runs_iteration_check",
      sql`${table.iteration} is null or ${table.containerStepRunId} is not null`
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
    // The step runs of one block, by step and item: its counts, and the step an inner step
    // refers to.
    index("workflow_step_runs_container_idx")
      .on(table.containerStepRunId, table.stepId, table.iteration)
      .where(sql`${table.containerStepRunId} is not null`),
    // The steps that wait for an Operation Run, which its end wakes (EW-ASYNC).
    index("workflow_step_runs_waiting_operation_idx")
      .on(table.operationRunId)
      .where(sql`${table.status} = 'waiting'`),
    // The steps linked to a run, which its end wakes (EW-13k).
    index("workflow_step_runs_linked_run_idx")
      .on(table.linkedRunId)
      .where(sql`${table.linkedRunId} is not null`)
  ]
);
