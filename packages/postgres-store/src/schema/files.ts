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
import type {
  ArtifactPreviewImageFormat,
  ArtifactPreviewImagePageRef,
  ArtifactPreviewJobRecord,
  ArtifactPreviewManifest,
  ConversationAttachment,
  ManagedArtifactRecord,
  ManagedFileRecord
} from "@vivd-catalyst/core";
import { conversations, messages } from "./conversations";

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
    artifactRefs: jsonb("artifact_refs")
      .$type<ConversationAttachment["artifactRefs"]>()
      .notNull()
      .default({}),
    processingMetadata: jsonb("processing_metadata")
      .$type<ConversationAttachment["processingMetadata"]>()
      .notNull()
      .default({}),
    warnings: jsonb("warnings").$type<ConversationAttachment["warnings"]>().notNull(),
    error: jsonb("error").$type<NonNullable<ConversationAttachment["error"]>>(),
    processingOwnerId: text("processing_owner_id"),
    processingLeaseToken: text("processing_lease_token"),
    processingLeaseExpiresAt: timestamp("processing_lease_expires_at", { withTimezone: true }),
    processingAttempts: integer("processing_attempts").notNull().default(0),
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
    index("conversation_attachments_file_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.fileId
    ),
    index("conversation_attachments_processing_idx").on(
      table.clientInstanceId,
      table.status,
      table.processingLeaseExpiresAt,
      table.createdAt
    )
  ]
);

export const managedArtifacts = pgTable(
  "managed_artifacts",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceFileId: text("source_file_id").references(() => managedFiles.id, {
      onDelete: "restrict"
    }),
    kind: text("kind").$type<ManagedArtifactRecord["kind"]>().notNull(),
    objectKey: text("object_key").notNull(),
    filename: text("filename"),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    metadata: jsonb("metadata").$type<ManagedArtifactRecord["metadata"]>().notNull(),
    status: text("status").$type<ManagedArtifactRecord["status"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    index("managed_artifacts_conversation_idx").on(table.clientInstanceId, table.conversationId),
    index("managed_artifacts_file_kind_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.sourceFileId,
      table.kind,
      table.createdAt.desc()
    ),
    index("managed_artifacts_object_key_idx").on(table.clientInstanceId, table.objectKey)
  ]
);

export const artifactPreviewJobs = pgTable(
  "artifact_preview_jobs",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceArtifactId: text("source_artifact_id")
      .notNull()
      .references(() => managedArtifacts.id, { onDelete: "cascade" }),
    sourceChecksum: text("source_checksum").notNull(),
    sourceMimeType: text("source_mime_type").notNull(),
    renderer: text("renderer").notNull(),
    rendererVersion: text("renderer_version").notNull(),
    settingsHash: text("settings_hash").notNull(),
    status: text("status").$type<ArtifactPreviewJobRecord["status"]>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseOwnerId: text("lease_owner_id"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("artifact_preview_jobs_source_settings_idx").on(
      table.clientInstanceId,
      table.sourceArtifactId,
      table.renderer,
      table.rendererVersion,
      table.settingsHash
    ),
    index("artifact_preview_jobs_queue_idx").on(
      table.clientInstanceId,
      table.status,
      table.nextAttemptAt,
      table.createdAt
    ),
    index("artifact_preview_jobs_conversation_idx").on(table.clientInstanceId, table.conversationId)
  ]
);

export const artifactPreviewManifests = pgTable(
  "artifact_preview_manifests",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceArtifactId: text("source_artifact_id")
      .notNull()
      .references(() => managedArtifacts.id, { onDelete: "cascade" }),
    renderer: text("renderer").notNull(),
    rendererVersion: text("renderer_version").notNull(),
    settingsHash: text("settings_hash").notNull(),
    status: text("status").$type<ArtifactPreviewManifest["status"]>().notNull(),
    type: text("type").$type<"image_pages">(),
    format: text("format").$type<ArtifactPreviewImageFormat>(),
    pageCount: integer("page_count").notNull().default(0),
    pages: jsonb("pages").$type<ArtifactPreviewImagePageRef[]>().notNull().default([]),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "artifact_preview_manifests_pk",
      columns: [
        table.clientInstanceId,
        table.sourceArtifactId,
        table.renderer,
        table.rendererVersion,
        table.settingsHash
      ]
    }),
    index("artifact_preview_manifests_conversation_idx").on(
      table.clientInstanceId,
      table.conversationId
    )
  ]
);
