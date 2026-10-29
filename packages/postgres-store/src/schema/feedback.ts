import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type { FeedbackState, FeedbackSubjectKind } from "@work-shape/catalyst-core";
import { agentRuns } from "./agentRuns";
import { workflowRuns } from "./workflowRuns";
import { configAssets } from "./configAssets";
import { conversations, messages } from "./conversations";
import { productUsers } from "./users";
import { collaborationWorkspaces } from "./workspaces";

/**
 * Written comments on agent messages (LU-4), on Apps and on Workflow results (LU-6). A comment
 * outlives what it is about: deleting the conversation, a run, the agent, the App or the
 * Workflow clears the reference and keeps the comment and the copy of the exchange, which
 * follow the feedback retention. Deleting the author deletes it.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    subjectKind: text("subject_kind").$type<FeedbackSubjectKind>().notNull(),
    messageId: text("message_id"),
    // The agent of a `message` comment.
    agentName: text("agent_name"),
    agentAssetId: text("agent_asset_id"),
    agentRevision: integer("agent_revision"),
    agentWorkspaceId: text("agent_workspace_id"),
    // The App of an `app` comment, or the Workflow of a `workflow_run` comment.
    assetName: text("asset_name"),
    assetId: text("asset_id"),
    assetRevision: integer("asset_revision"),
    assetWorkspaceId: text("asset_workspace_id"),
    workflowRunId: text("workflow_run_id"),
    conversationId: text("conversation_id"),
    agentRunId: text("agent_run_id"),
    workspaceId: text("workspace_id"),
    authorUserId: text("author_user_id").notNull(),
    text: text("text").notNull(),
    exchangeQuestion: text("exchange_question"),
    exchangeAnswer: text("exchange_answer"),
    // Written by a workflow (`feedback.annotate`), never by a person.
    summary: text("summary"),
    category: text("category"),
    annotatedAt: timestamp("annotated_at", { withTimezone: true }),
    state: text("state").$type<FeedbackState>().notNull(),
    handledByUserId: text("handled_by_user_id"),
    handledByLabel: text("handled_by_label"),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    handledNote: text("handled_note"),
    approvalRequestId: text("approval_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    check(
      "feedback_subject_kind_check",
      sql`${table.subjectKind} in ('message', 'app', 'workflow_run')`
    ),
    // A comment on an answer names its agent; any other names its App or its Workflow.
    check(
      "feedback_subject_asset_check",
      sql`(${table.subjectKind} = 'message') = (${table.agentName} is not null) and (${table.subjectKind} = 'message') = (${table.assetName} is null)`
    ),
    check("feedback_state_check", sql`${table.state} in ('new', 'handled')`),
    check(
      "feedback_exchange_check",
      sql`(${table.exchangeQuestion} is null) = (${table.exchangeAnswer} is null)`
    ),
    // One comment per person per message.
    uniqueIndex("feedback_client_message_author_idx")
      .on(table.clientInstanceId, table.messageId, table.authorUserId)
      .where(sql`${table.messageId} is not null`),
    // The reviewer's list, newest first, and the retention sweep, oldest first.
    index("feedback_client_created_idx").on(table.clientInstanceId, table.createdAt, table.id),
    // One comment per person per Workflow run.
    uniqueIndex("feedback_client_workflow_run_author_idx")
      .on(table.clientInstanceId, table.workflowRunId, table.authorUserId)
      .where(sql`${table.workflowRunId} is not null`),
    index("feedback_client_asset_created_idx").on(
      table.clientInstanceId,
      table.assetId,
      table.createdAt
    ),
    index("feedback_client_agent_created_idx").on(
      table.clientInstanceId,
      table.agentAssetId,
      table.createdAt
    ),
    // The author's comments in one conversation, and what an account deletion removes.
    index("feedback_client_author_idx").on(
      table.clientInstanceId,
      table.authorUserId,
      table.conversationId
    ),
    foreignKey({
      name: "feedback_author_fk",
      columns: [table.clientInstanceId, table.authorUserId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "feedback_message_fk",
      columns: [table.messageId],
      foreignColumns: [messages.id]
    }).onDelete("set null"),
    foreignKey({
      name: "feedback_conversation_fk",
      columns: [table.conversationId],
      foreignColumns: [conversations.id]
    }).onDelete("set null"),
    foreignKey({
      name: "feedback_agent_run_fk",
      columns: [table.agentRunId],
      foreignColumns: [agentRuns.id]
    }).onDelete("set null"),
    foreignKey({
      name: "feedback_agent_asset_fk",
      columns: [table.agentAssetId],
      foreignColumns: [configAssets.id]
    }).onDelete("set null"),
    foreignKey({
      name: "feedback_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [collaborationWorkspaces.id]
    }).onDelete("set null"),
    foreignKey({
      name: "feedback_asset_fk",
      columns: [table.assetId],
      foreignColumns: [configAssets.id]
    }).onDelete("set null"),
    foreignKey({
      name: "feedback_asset_workspace_fk",
      columns: [table.assetWorkspaceId],
      foreignColumns: [collaborationWorkspaces.id]
    }).onDelete("set null"),
    foreignKey({
      name: "feedback_workflow_run_fk",
      columns: [table.workflowRunId],
      foreignColumns: [workflowRuns.id]
    }).onDelete("set null"),
    foreignKey({
      name: "feedback_agent_workspace_fk",
      columns: [table.agentWorkspaceId],
      foreignColumns: [collaborationWorkspaces.id]
    }).onDelete("set null"),
    // What deleting a message, a conversation or a run finds its comments by.
    index("feedback_message_idx")
      .on(table.messageId)
      .where(sql`${table.messageId} is not null`),
    index("feedback_conversation_idx")
      .on(table.conversationId)
      .where(sql`${table.conversationId} is not null`),
    index("feedback_agent_run_idx")
      .on(table.agentRunId)
      .where(sql`${table.agentRunId} is not null`),
    index("feedback_workflow_run_idx")
      .on(table.workflowRunId)
      .where(sql`${table.workflowRunId} is not null`)
  ]
);
