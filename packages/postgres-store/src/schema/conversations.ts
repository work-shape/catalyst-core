import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp
} from "drizzle-orm/pg-core";
import type {
  ChatMessage,
  Conversation,
  ConversationCreationTarget,
  ConversationKind,
  ModelProviderContinuationCheckpoint
} from "@work-shape/catalyst-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { collaborationWorkspaces } from "./workspaces";

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    // A chat conversation, or the run thread of a Child Agent Run. Every reader that lists,
    // counts or deletes conversations says which it means.
    kind: text("kind").$type<ConversationKind>().notNull().default("chat"),
    // A subagent's thread names its root chat conversation, an agent step's thread its
    // Workflow run. A chat conversation names neither.
    parentConversationId: text("parent_conversation_id").references(
      (): AnyPgColumn => conversations.id,
      { onDelete: "cascade" }
    ),
    workflowRunId: text("workflow_run_id"),
    // Null only on an agent step's thread, which belongs to no workspace and no person.
    collaborationWorkspaceId: text("collaboration_workspace_id"),
    createdByUserId: text("created_by_user_id"),
    createdByExternalUserId: text("created_by_external_user_id"),
    visibility: text("visibility").$type<Conversation["visibility"]>().notNull(),
    title: text("title").notNull(),
    status: text("status").$type<Conversation["status"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    retainedUntil: timestamp("retained_until", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    personalDataAt: timestamp("personal_data_at", { withTimezone: true }),
    // The asset the conversation is about, by kind and name. Both null on every other one.
    subjectKind: text("subject_kind"),
    subjectName: text("subject_name"),
    // Where the first saves create an agent, skill or guardrail: 'instance' for a conversation
    // started under Studio's scope "Instance", else null. Set at insert only, never updated.
    creationTarget: text("creation_target").$type<ConversationCreationTarget>()
  },
  (table) => [
    check("conversations_kind_check", sql`${table.kind} in ('chat', 'run_thread')`),
    check(
      "conversations_creation_target_check",
      sql`${table.creationTarget} is null or ${table.creationTarget} = 'instance'`
    ),
    check(
      "conversations_run_thread_check",
      sql`(${table.kind} = 'chat' and ${table.parentConversationId} is null and ${table.workflowRunId} is null and ${table.collaborationWorkspaceId} is not null and ${table.createdByUserId} is not null and ${table.createdByExternalUserId} is not null) or (${table.kind} = 'run_thread' and ((${table.parentConversationId} is not null and ${table.workflowRunId} is null and ${table.collaborationWorkspaceId} is not null and ${table.createdByUserId} is not null and ${table.createdByExternalUserId} is not null) or (${table.parentConversationId} is null and ${table.workflowRunId} is not null and ${table.collaborationWorkspaceId} is null and ${table.createdByUserId} is null and ${table.createdByExternalUserId} is null)))`
    ),
    index("conversations_parent_idx")
      .on(table.clientInstanceId, table.parentConversationId)
      .where(sql`${table.parentConversationId} is not null`),
    index("conversations_workflow_run_idx")
      .on(table.clientInstanceId, table.workflowRunId)
      .where(sql`${table.workflowRunId} is not null`),
    index("conversations_retention_expiry_idx").on(
      table.clientInstanceId,
      table.status,
      table.retainedUntil
    ),
    foreignKey({
      name: "conversations_collaboration_workspace_fk",
      columns: [table.clientInstanceId, table.collaborationWorkspaceId],
      foreignColumns: [collaborationWorkspaces.clientInstanceId, collaborationWorkspaces.id]
    }).onDelete("restrict"),
    index("conversations_collaboration_workspace_idx").on(
      table.clientInstanceId,
      table.collaborationWorkspaceId
    ),
    index("conversations_workspace_visibility_idx").on(
      table.clientInstanceId,
      table.collaborationWorkspaceId,
      table.visibility,
      table.createdByUserId
    ),
    // The list of a workspace, newest first, as an index range. Ascending with the tie-break:
    // Postgres reads it backwards for `order by updated_at desc, id desc`.
    index("conversations_workspace_updated_idx").on(
      table.clientInstanceId,
      table.collaborationWorkspaceId,
      table.status,
      table.updatedAt,
      table.id
    )
  ]
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").$type<ChatMessage["role"]>().notNull(),
    text: text("text").notNull(),
    storageOrdinal: bigserial("storage_ordinal", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").$type<NonNullable<ChatMessage["metadata"]>>().notNull()
  },
  (table) => [
    index("messages_conversation_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.createdAt.asc()
    )
  ]
);

export const modelProviderContinuations = pgTable(
  "model_provider_continuations",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    state: jsonb("state").$type<ModelProviderContinuationCheckpoint["state"]>().notNull(),
    sourceMessageId: text("source_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    sourceStorageOrdinal: bigint("source_storage_ordinal", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "model_provider_continuations_pk",
      columns: [table.clientInstanceId, table.conversationId, table.providerId]
    })
  ]
);
