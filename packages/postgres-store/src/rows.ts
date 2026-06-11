import {
  AppError,
  type AuditEvent,
  type ChatMessage,
  type ClientInstanceId,
  type Conversation,
  type ModelUsageEvent,
  type UserIdentity,
  type UserRecord,
  asConversationId,
  asMessageId,
  asUserId
} from "@vivd-stage/core";
import type {
  auditEvents,
  conversations,
  messages,
  modelUsageEvents,
  productUsers,
  userIdentities
} from "./schema";

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
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
