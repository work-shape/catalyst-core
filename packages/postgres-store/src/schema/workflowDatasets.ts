import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  ClientInstanceId,
  WorkflowRunId,
  WorkflowStepRunId,
  JsonObject,
  WorkflowDatasetState,
  WorkflowDatasetPart
} from "@work-shape/catalyst-core";

// Tombstones survive run deletion so cleanup can still find the object prefix after a crash.
export const workflowRunDatasets = pgTable(
  "workflow_run_datasets",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    runId: text("run_id").$type<WorkflowRunId>().notNull(),
    stepRunId: text("step_run_id").$type<WorkflowStepRunId>().notNull(),
    field: text("field").notNull(),
    rowSchema: jsonb("row_schema").$type<JsonObject>().notNull(),
    rowCount: bigint("row_count", { mode: "number" }).notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    parts: jsonb("parts").$type<WorkflowDatasetPart[]>().notNull().default([]),
    pendingPart: jsonb("pending_part").$type<WorkflowDatasetPart>(),
    state: text("state").$type<WorkflowDatasetState>().notNull().default("writing"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    cleanedAt: timestamp("cleaned_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("workflow_run_datasets_step_field_idx").on(
      table.clientInstanceId,
      table.stepRunId,
      table.field
    ),
    index("workflow_run_datasets_run_idx").on(table.clientInstanceId, table.runId, table.id),
    index("workflow_run_datasets_expiry_idx")
      .on(table.clientInstanceId, table.expiresAt, table.id)
      .where(sql`${table.cleanedAt} is null`)
  ]
);

/** Constant-cost byte admission, independent of the number of datasets. */
export const workflowDatasetUsage = pgTable(
  "workflow_dataset_usage",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    scope: text("scope").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0)
  },
  (table) => [primaryKey({ columns: [table.clientInstanceId, table.scope] })]
);

export const workflowDatasetReaders = pgTable(
  "workflow_dataset_readers",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    datasetId: text("dataset_id").notNull(),
    runId: text("run_id").$type<WorkflowRunId>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({ columns: [table.clientInstanceId, table.datasetId, table.runId] }),
    index("workflow_dataset_readers_run_idx").on(table.clientInstanceId, table.runId)
  ]
);
