import {
  AppError,
  type AgentRun,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewManifest,
  type AuditEvent,
  type ChatMessage,
  type ClientInstanceId,
  type Conversation,
  type ConversationAttachment,
  type ExecutionWorkspace,
  type ManagedArtifactRecord,
  type ModelUsageEvent,
  type ManagedFileRecord,
  type RunObservation,
  type WorkspaceCommand,
  type WorkspaceFile,
  type UserIdentity,
  type UserRecord,
  asAgentRunId,
  asConversationAttachmentId,
  asConversationId,
  asExecutionWorkspaceId,
  asManagedArtifactId,
  asManagedFileId,
  asMessageId,
  asToolCallId,
  asUserId,
  asWorkspaceCommandId
} from "@vivd-catalyst/core";
import type {
  agentRunObservations,
  agentRuns,
  artifactPreviewJobs,
  artifactPreviewManifests,
  auditEvents,
  conversationAttachments,
  conversations,
  executionWorkspaceFiles,
  executionWorkspaces,
  managedArtifacts,
  managedFiles,
  messages,
  modelUsageEvents,
  productUsers,
  userIdentities,
  workspaceCommands
} from "./schema";

export type AgentRunRow = typeof agentRuns.$inferSelect;
export type ArtifactPreviewJobRow = typeof artifactPreviewJobs.$inferSelect;
export type ArtifactPreviewManifestRow = typeof artifactPreviewManifests.$inferSelect;
export type RunObservationRow = typeof agentRunObservations.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
export type WorkspaceFileRow = typeof executionWorkspaceFiles.$inferSelect;
export type WorkspaceCommandRow = typeof workspaceCommands.$inferSelect;
export type ManagedFileRow = typeof managedFiles.$inferSelect;
export type ManagedArtifactRow = typeof managedArtifacts.$inferSelect;
export type ConversationAttachmentRow = typeof conversationAttachments.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type ModelUsageEventRow = typeof modelUsageEvents.$inferSelect;
export type ProductUserRow = typeof productUsers.$inferSelect;
export type UserIdentityRow = typeof userIdentities.$inferSelect;

export function mapConversation(row: ConversationRow | undefined): Conversation {
  if (!row) {
    throw new AppError("INTERNAL", "Expected conversation row");
  }
  return {
    id: asConversationId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    ownerUserId: row.ownerUserId,
    ownerExternalUserId: row.ownerExternalUserId,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    retainedUntil: row.retainedUntil.toISOString(),
    deletedAt: row.deletedAt?.toISOString()
  };
}

export function mapMessage(row: MessageRow | undefined): ChatMessage {
  if (!row) {
    throw new AppError("INTERNAL", "Expected message row");
  }
  return {
    id: asMessageId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    role: row.role,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    metadata: row.metadata
  };
}

export function mapAgentRun(row: AgentRunRow | undefined): AgentRun {
  if (!row) {
    throw new AppError("INTERNAL", "Expected agent run row");
  }
  return {
    id: asAgentRunId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    ownerUserId: row.ownerUserId,
    inputMessageId: asMessageId(row.inputMessageId),
    agentName: row.agentName,
    status: row.status,
    idempotencyKey: row.idempotencyKey ?? undefined,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString(),
    failedAt: row.failedAt?.toISOString(),
    lastSequence: row.lastSequence,
    error: row.error ?? undefined,
    correlationId: row.correlationId,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString(),
    heartbeatAt: row.heartbeatAt?.toISOString()
  };
}

export function mapRunObservation(row: RunObservationRow | undefined): RunObservation {
  if (!row) {
    throw new AppError("INTERNAL", "Expected agent run observation row");
  }
  return {
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    runId: asAgentRunId(row.runId),
    conversationId: asConversationId(row.conversationId),
    ownerUserId: row.ownerUserId,
    sequence: row.sequence,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt.toISOString()
  };
}

export function mapExecutionWorkspace(row: ExecutionWorkspaceRow | undefined): ExecutionWorkspace {
  if (!row) {
    throw new AppError("INTERNAL", "Expected execution workspace row");
  }
  return {
    id: asExecutionWorkspaceId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    ownerUserId: row.ownerUserId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString()
  };
}

export function mapWorkspaceFile(row: WorkspaceFileRow | undefined): WorkspaceFile {
  if (!row) {
    throw new AppError("INTERNAL", "Expected workspace file row");
  }
  return {
    workspaceId: asExecutionWorkspaceId(row.workspaceId),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    path: row.path,
    objectKey: row.objectKey,
    byteSize: row.byteSize,
    checksum: row.checksum,
    mimeType: row.mimeType ?? undefined,
    metadata: row.metadata,
    lastCommandId: row.lastCommandId ? asWorkspaceCommandId(row.lastCommandId) : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function mapWorkspaceCommand(row: WorkspaceCommandRow | undefined): WorkspaceCommand {
  if (!row) {
    throw new AppError("INTERNAL", "Expected workspace command row");
  }
  return {
    id: asWorkspaceCommandId(row.id),
    workspaceId: asExecutionWorkspaceId(row.workspaceId),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    ownerUserId: row.ownerUserId,
    agentRunId: row.agentRunId ? asAgentRunId(row.agentRunId) : undefined,
    toolCallId: row.toolCallId ? asToolCallId(row.toolCallId) : undefined,
    command: row.command,
    cwd: row.cwd ?? undefined,
    status: row.status,
    limits: row.limits,
    expectedOutputs: row.expectedOutputs,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseToken: row.leaseToken ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString(),
    heartbeatAt: row.heartbeatAt?.toISOString(),
    attempts: row.attempts,
    cancellationReason: row.cancellationReason ?? undefined,
    cancellationRequestedAt: row.cancellationRequestedAt?.toISOString(),
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function mapManagedFile(row: ManagedFileRow | undefined): ManagedFileRecord {
  if (!row) {
    throw new AppError("INTERNAL", "Expected managed file row");
  }
  return {
    id: asManagedFileId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    ownerUserId: row.ownerUserId,
    filename: row.filename,
    mimeType: row.mimeType ?? undefined,
    byteSize: row.byteSize,
    checksum: row.checksum,
    objectKey: row.objectKey,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString()
  };
}

export function mapManagedArtifact(row: ManagedArtifactRow | undefined): ManagedArtifactRecord {
  if (!row) {
    throw new AppError("INTERNAL", "Expected managed artifact row");
  }
  return {
    id: asManagedArtifactId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    sourceFileId: row.sourceFileId ? asManagedFileId(row.sourceFileId) : undefined,
    kind: row.kind,
    objectKey: row.objectKey,
    filename: row.filename ?? undefined,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    checksum: row.checksum,
    metadata: row.metadata,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString()
  };
}

export function mapArtifactPreviewJob(row: ArtifactPreviewJobRow | undefined): ArtifactPreviewJobRecord {
  if (!row) {
    throw new AppError("INTERNAL", "Expected artifact preview job row");
  }
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    sourceArtifactId: asManagedArtifactId(row.sourceArtifactId),
    sourceChecksum: row.sourceChecksum,
    sourceMimeType: row.sourceMimeType,
    renderer: row.renderer,
    rendererVersion: row.rendererVersion,
    settingsHash: row.settingsHash,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString(),
    leaseOwnerId: row.leaseOwnerId ?? undefined,
    leaseToken: row.leaseToken ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString(),
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function mapArtifactPreviewManifest(
  row: ArtifactPreviewManifestRow | undefined
): ArtifactPreviewManifest {
  if (!row) {
    throw new AppError("INTERNAL", "Expected artifact preview manifest row");
  }
  const common = {
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    sourceArtifactId: asManagedArtifactId(row.sourceArtifactId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
  if (row.status === "ready") {
    if (row.type !== "image_pages" || !row.format) {
      throw new AppError("INTERNAL", "Ready artifact preview manifest is incomplete");
    }
    return {
      ...common,
      status: "ready",
      type: "image_pages",
      format: row.format,
      pageCount: row.pageCount,
      pages: row.pages
    };
  }
  if (row.status === "failed" || row.status === "unsupported") {
    return {
      ...common,
      status: row.status,
      ...(row.errorCode ? { errorCode: row.errorCode } : {})
    };
  }
  throw new AppError("INTERNAL", "Unsupported artifact preview manifest status");
}

export function mapConversationAttachment(
  row: ConversationAttachmentRow | undefined
): ConversationAttachment {
  if (!row) {
    throw new AppError("INTERNAL", "Expected conversation attachment row");
  }
  return {
    id: asConversationAttachmentId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    messageId: row.messageId ? asMessageId(row.messageId) : undefined,
    fileId: asManagedFileId(row.fileId),
    filename: row.filename,
    mimeType: row.mimeType ?? undefined,
    byteSize: row.byteSize,
    checksum: row.checksum,
    status: row.status,
    format: row.format ?? undefined,
    artifactRefs: row.artifactRefs,
    processingMetadata: row.processingMetadata,
    warnings: row.warnings,
    error: row.error ?? undefined,
    processingOwnerId: row.processingOwnerId ?? undefined,
    processingLeaseToken: row.processingLeaseToken ?? undefined,
    processingLeaseExpiresAt: row.processingLeaseExpiresAt?.toISOString(),
    processingAttempts: row.processingAttempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    preprocessingStartedAt: row.preprocessingStartedAt?.toISOString(),
    preprocessingCompletedAt: row.preprocessingCompletedAt?.toISOString(),
    deletedAt: row.deletedAt?.toISOString()
  };
}

export function mapAuditEvent(row: AuditEventRow | undefined): AuditEvent {
  if (!row) {
    throw new AppError("INTERNAL", "Expected audit event row");
  }
  return {
    id: row.id as AuditEvent["id"],
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    type: row.type,
    status: row.status,
    actor: row.actor ?? undefined,
    subject: row.subject ?? undefined,
    reason: row.reason ?? undefined,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
    metadata: row.metadata
  };
}

export function mapModelUsageEvent(row: ModelUsageEventRow | undefined): ModelUsageEvent {
  if (!row) {
    throw new AppError("INTERNAL", "Expected model usage event row");
  }
  return {
    id: row.id as ModelUsageEvent["id"],
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    agentRunId: row.agentRunId as ModelUsageEvent["agentRunId"],
    agentName: row.agentName,
    providerId: row.providerId,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    webSearchCallCount: row.webSearchCallCount,
    source: row.source,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString()
  };
}

export function mapUserIdentity(row: UserIdentityRow | undefined): UserIdentity {
  if (!row) {
    throw new AppError("INTERNAL", "Expected user identity row");
  }
  return {
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    userId: asUserId(row.userId),
    authSource: row.authSource,
    externalUserId: row.externalUserId,
    displayLabel: row.displayLabel ?? undefined,
    email: row.email ?? undefined,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastAuthenticatedAt: row.lastAuthenticatedAt?.toISOString()
  };
}

export function mapUserRecord(
  row: ProductUserRow | undefined,
  identities: UserIdentity[] = []
): UserRecord {
  if (!row) {
    throw new AppError("INTERNAL", "Expected user row");
  }
  return {
    id: asUserId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    displayLabel: row.displayLabel,
    email: row.email ?? undefined,
    roles: row.roles,
    permissionRefs: row.permissionRefs,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastAuthenticatedAt: row.lastAuthenticatedAt?.toISOString(),
    identities
  };
}
