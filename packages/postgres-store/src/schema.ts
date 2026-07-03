import { sql } from "drizzle-orm";
import {
  boolean,
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
  AgentRun,
  ArtifactPreviewImageFormat,
  ArtifactPreviewImagePageRef,
  ArtifactPreviewJobRecord,
  ArtifactPreviewManifest,
  AuditEvent,
  ChatMessage,
  ConversationAttachment,
  Conversation,
  ExecutionWorkspace,
  ManagedArtifactRecord,
  ManagedFileRecord,
  ModelUsageEvent,
  RunObservation,
  RunStartCommand,
  UserRecord,
  WorkspaceCommand,
  WorkspaceFile
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
    ),
    index("conversations_retention_expiry_idx").on(
      table.clientInstanceId,
      table.status,
      table.retainedUntil
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

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    inputMessageId: text("input_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    agentName: text("agent_name").notNull(),
    status: text("status").$type<AgentRun["status"]>().notNull(),
    idempotencyKey: text("idempotency_key"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastSequence: integer("last_sequence").notNull().default(0),
    error: jsonb("error").$type<NonNullable<AgentRun["error"]>>(),
    correlationId: text("correlation_id").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("agent_runs_active_conversation_idx")
      .on(table.clientInstanceId, table.conversationId)
      .where(sql`${table.status} in ('queued', 'running', 'waiting_for_permission', 'cancelling')`),
    uniqueIndex("agent_runs_idempotency_idx")
      .on(table.clientInstanceId, table.conversationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("agent_runs_conversation_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.updatedAt.desc()
    ),
    index("agent_runs_owner_created_idx").on(
      table.clientInstanceId,
      table.ownerUserId,
      table.startedAt.desc()
    )
  ]
);

export const agentRunObservations = pgTable(
  "agent_run_observations",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").$type<RunObservation["type"]>().notNull(),
    payload: jsonb("payload").$type<RunObservation["payload"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "agent_run_observations_pk",
      columns: [table.runId, table.sequence]
    }),
    index("agent_run_observations_conversation_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.runId,
      table.sequence
    ),
    index("agent_run_observations_owner_created_idx").on(
      table.clientInstanceId,
      table.ownerUserId,
      table.createdAt
    )
  ]
);

export const runStartCommands = pgTable(
  "run_start_commands",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandKind: text("command_kind").$type<RunStartCommand["commandKind"]>().notNull(),
    status: text("status").$type<RunStartCommand["status"]>().notNull(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade"
    }),
    userMessageId: text("user_message_id").references(() => messages.id, {
      onDelete: "cascade"
    }),
    runId: text("run_id").references(() => agentRuns.id, {
      onDelete: "cascade"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("run_start_commands_idempotency_idx").on(
      table.clientInstanceId,
      table.ownerUserId,
      table.commandKind,
      table.idempotencyKey
    ),
    index("run_start_commands_run_idx").on(table.clientInstanceId, table.runId)
  ]
);

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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
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
    index("conversation_attachments_file_idx").on(table.clientInstanceId, table.conversationId, table.fileId),
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
    sourceFileId: text("source_file_id").references(() => managedFiles.id, { onDelete: "restrict" }),
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
    index("artifact_preview_jobs_conversation_idx").on(
      table.clientInstanceId,
      table.conversationId
    )
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
    webSearchCallCount: integer("web_search_call_count").notNull().default(0),
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
  agentRuns,
  agentRunObservations,
  runStartCommands,
  executionWorkspaces,
  workspaceCommands,
  executionWorkspaceFiles,
  managedFiles,
  managedArtifacts,
  artifactPreviewJobs,
  artifactPreviewManifests,
  conversationAttachments,
  auditEvents,
  modelUsageEvents
};
