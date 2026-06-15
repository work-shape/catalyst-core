import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp
} from "drizzle-orm/pg-core";
import type {
  AuditEvent,
  ChatMessage,
  ConversationAttachment,
  Conversation,
  ManagedFileRecord,
  ModelUsageEvent,
  UserRecord
} from "@vivd-catalyst/core";

export const productUsers = pgTable(
  "product_users",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    displayLabel: text("display_label").notNull(),
    email: text("email"),
    roles: jsonb("roles").$type<UserRecord["roles"]>().notNull(),
    permissionRefs: jsonb("permission_refs").$type<string[]>().notNull(),
    status: text("status").$type<UserRecord["status"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true })
  },
  (table) => [index("product_users_client_idx").on(table.clientInstanceId)]
);

export const userIdentities = pgTable(
  "user_identities",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => productUsers.id, { onDelete: "cascade" }),
    authSource: text("auth_source").notNull(),
    externalUserId: text("external_user_id").notNull(),
    displayLabel: text("display_label"),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({
      name: "user_identities_pk",
      columns: [table.clientInstanceId, table.authSource, table.externalUserId]
    }),
    index("user_identities_user_idx").on(table.clientInstanceId, table.userId)
  ]
);

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    ownerExternalUserId: text("owner_external_user_id").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<Conversation["status"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    retainedUntil: timestamp("retained_until", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    index("conversations_owner_idx").on(
      table.clientInstanceId,
      table.ownerExternalUserId,
      table.updatedAt.desc()
    ),
    index("conversations_owner_user_idx").on(
      table.clientInstanceId,
      table.ownerUserId,
      table.updatedAt.desc()
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

export const managedFiles = pgTable(
  "managed_files",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type"),
    byteSize: integer("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    objectKey: text("object_key").notNull(),
    status: text("status").$type<ManagedFileRecord["status"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    index("managed_files_client_owner_idx").on(table.clientInstanceId, table.ownerUserId),
    index("managed_files_checksum_idx").on(table.clientInstanceId, table.checksum)
  ]
);

export const conversationAttachments = pgTable(
  "conversation_attachments",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    fileId: text("file_id")
      .notNull()
      .references(() => managedFiles.id, { onDelete: "restrict" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type"),
    byteSize: integer("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    status: text("status").$type<ConversationAttachment["status"]>().notNull(),
    format: text("format").$type<ConversationAttachment["format"]>(),
    preparedDocumentId: text("prepared_document_id"),
    preparedObjectKey: text("prepared_object_key"),
    characterCount: integer("character_count"),
    wordCount: integer("word_count"),
    pageCount: integer("page_count"),
    warnings: jsonb("warnings").$type<ConversationAttachment["warnings"]>().notNull(),
    error: jsonb("error").$type<NonNullable<ConversationAttachment["error"]>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    preprocessingStartedAt: timestamp("preprocessing_started_at", { withTimezone: true }),
    preprocessingCompletedAt: timestamp("preprocessing_completed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    index("conversation_attachments_draft_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.messageId,
      table.updatedAt
    ),
    index("conversation_attachments_file_idx").on(table.clientInstanceId, table.conversationId, table.fileId)
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    type: text("type").notNull(),
    status: text("status").$type<AuditEvent["status"]>().notNull(),
    actor: jsonb("actor").$type<AuditEvent["actor"]>(),
    subject: text("subject"),
    reason: text("reason"),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").$type<NonNullable<AuditEvent["metadata"]>>().notNull()
  },
  (table) => [
    index("audit_events_client_created_idx").on(table.clientInstanceId, table.createdAt.desc())
  ]
);

export const modelUsageEvents = pgTable(
  "model_usage_events",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    agentRunId: text("agent_run_id").notNull(),
    agentName: text("agent_name").notNull(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    source: text("source").$type<ModelUsageEvent["source"]>().notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("model_usage_events_client_created_idx").on(
      table.clientInstanceId,
      table.createdAt.desc()
    )
  ]
);

export const schema = {
  productUsers,
  userIdentities,
  conversations,
  messages,
  managedFiles,
  conversationAttachments,
  auditEvents,
  modelUsageEvents
};
