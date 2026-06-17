import {
  AppError,
  type AuditEvent,
  type ChatMessage,
  type ClientInstanceId,
  type Conversation,
  type ConversationAttachment,
  type ManagedArtifactRecord,
  type ModelUsageEvent,
  type ManagedFileRecord,
  type UserIdentity,
  type UserRecord,
  asConversationAttachmentId,
  asConversationId,
  asManagedArtifactId,
  asManagedFileId,
  asMessageId,
  asUserId
} from "@vivd-catalyst/core";
import type {
  auditEvents,
  conversationAttachments,
  conversations,
  managedArtifacts,
  managedFiles,
  messages,
  modelUsageEvents,
  productUsers,
  userIdentities
} from "./schema";

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
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
    preparedTextArtifactId: row.preparedTextArtifactId
      ? asManagedArtifactId(row.preparedTextArtifactId)
      : undefined,
    preparedPagesArtifactId: row.preparedPagesArtifactId
      ? asManagedArtifactId(row.preparedPagesArtifactId)
      : undefined,
    preprocessingEngine: row.preprocessingEngine ?? undefined,
    characterCount: row.characterCount ?? undefined,
    wordCount: row.wordCount ?? undefined,
    pageCount: row.pageCount ?? undefined,
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
