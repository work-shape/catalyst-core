import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type { ScheduledStart } from "@work-shape/catalyst-core";
import { productUsers } from "./users";
import { collaborationWorkspaces } from "./workspaces";
import { conversations } from "./conversations";
import { agentRuns } from "./agentRuns";

export const scheduledStarts = pgTable(
  "scheduled_starts",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    collaborationWorkspaceId: text("collaboration_workspace_id").notNull(),
    agentName: text("agent_name").notNull(),
    prompt: text("prompt").notNull(),
    cron: text("cron").notNull(),
    timeZone: text("time_zone").notNull(),
    state: text("state").$type<ScheduledStart["state"]>().notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    personalConnectionsAllowed: boolean("personal_connections_allowed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    check("scheduled_starts_state_check", sql`${table.state} in ('active', 'paused')`),
    foreignKey({
      name: "scheduled_starts_owner_fk",
      columns: [table.clientInstanceId, table.ownerUserId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("restrict"),
    foreignKey({
      name: "scheduled_starts_workspace_fk",
      columns: [table.clientInstanceId, table.collaborationWorkspaceId],
      foreignColumns: [collaborationWorkspaces.clientInstanceId, collaborationWorkspaces.id]
    }).onDelete("cascade"),
    index("scheduled_starts_owner_created_idx").on(
      table.clientInstanceId,
      table.ownerUserId,
      table.createdAt,
      table.id
    ),
    index("scheduled_starts_workspace_created_idx").on(
      table.clientInstanceId,
      table.collaborationWorkspaceId,
      table.ownerUserId,
      table.createdAt,
      table.id
    )
  ]
);

export const scheduledStartRuns = pgTable(
  "scheduled_start_runs",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    scheduledStartId: text("scheduled_start_id").references(() => scheduledStarts.id, {
      onDelete: "set null"
    }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade"
    }),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    reason: text("reason"),
    personalConnectionsAllowed: boolean("personal_connections_allowed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("scheduled_start_runs_due_idx").on(
      table.clientInstanceId,
      table.scheduledStartId,
      table.scheduledFor
    ),
    uniqueIndex("scheduled_start_runs_agent_run_idx").on(table.agentRunId),
    index("scheduled_start_runs_conversation_idx").on(table.conversationId),
    index("scheduled_start_runs_created_idx").on(
      table.scheduledStartId,
      table.clientInstanceId,
      table.createdAt,
      table.id
    ),
    index("scheduled_start_runs_latest_started_idx")
      .on(table.clientInstanceId, table.scheduledStartId, table.createdAt, table.id)
      .where(sql`${table.agentRunId} is not null`)
  ]
);
