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
import type { ExecutionWorkspace, WorkspaceCommand, WorkspaceFile } from "@vivd-catalyst/core";
import { conversations } from "./conversations";
import { agentRuns } from "./agentRuns";

export const executionWorkspaces = pgTable(
  "execution_workspaces",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    status: text("status").$type<ExecutionWorkspace["status"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("execution_workspaces_conversation_idx").on(
      table.clientInstanceId,
      table.conversationId
    ),
    index("execution_workspaces_owner_idx").on(
      table.clientInstanceId,
      table.ownerUserId,
      table.updatedAt.desc()
    )
  ]
);

export const workspaceCommands = pgTable(
  "workspace_commands",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => executionWorkspaces.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    toolCallId: text("tool_call_id"),
    command: text("command").notNull(),
    cwd: text("cwd"),
    status: text("status").$type<WorkspaceCommand["status"]>().notNull(),
    limits: jsonb("limits").$type<WorkspaceCommand["limits"]>().notNull(),
    expectedOutputs: jsonb("expected_outputs")
      .$type<WorkspaceCommand["expectedOutputs"]>()
      .notNull()
      .default([]),
    output: jsonb("output").$type<NonNullable<WorkspaceCommand["output"]>>(),
    error: jsonb("error").$type<NonNullable<WorkspaceCommand["error"]>>(),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    cancellationReason: text("cancellation_reason"),
    cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("workspace_commands_workspace_idx").on(table.clientInstanceId, table.workspaceId),
    index("workspace_commands_agent_run_idx").on(table.clientInstanceId, table.agentRunId),
    index("workspace_commands_queue_idx").on(
      table.clientInstanceId,
      table.status,
      table.queuedAt.asc()
    ),
    index("workspace_commands_lease_idx").on(
      table.clientInstanceId,
      table.status,
      table.leaseExpiresAt
    )
  ]
);

export const executionWorkspaceFiles = pgTable(
  "execution_workspace_files",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => executionWorkspaces.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    objectKey: text("object_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    mimeType: text("mime_type"),
    metadata: jsonb("metadata").$type<WorkspaceFile["metadata"]>().notNull().default({}),
    lastCommandId: text("last_command_id").references(() => workspaceCommands.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({
      name: "execution_workspace_files_pk",
      columns: [table.workspaceId, table.path]
    }),
    index("execution_workspace_files_workspace_idx").on(
      table.clientInstanceId,
      table.workspaceId,
      table.updatedAt.desc()
    ),
    index("execution_workspace_files_object_key_idx").on(table.clientInstanceId, table.objectKey)
  ]
);
