import {
  bigint,
  bigserial,
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
  ModelProviderContinuationCheckpoint
} from "@vivd-catalyst/core";
import { collaborationWorkspaces } from "./workspaces";

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    collaborationWorkspaceId: text("collaboration_workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdByExternalUserId: text("created_by_external_user_id").notNull(),
    visibility: text("visibility").$type<Conversation["visibility"]>().notNull(),
    title: text("title").notNull(),
    status: text("status").$type<Conversation["status"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    retainedUntil: timestamp("retained_until", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
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
