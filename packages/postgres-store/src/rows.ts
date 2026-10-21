import type { AppAvailability } from "@work-shape/catalyst-core";
import {
  AppError,
  type AgentRun,
  type ApprovalRequest,
  type AssetScope,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewManifest,
  type AuditEvent,
  type ChatMessage,
  type CollaborationWorkspace,
  type CollaborationWorkspaceWithRole,
  type ClientInstanceId,
  type ApiCredentialRecord,
  type PersonalApiKeyRecord,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type ConfigAssetState,
  type Conversation,
  type ConversationAttachment,
  type ExecutionWorkspace,
  type ManagedArtifactRecord,
  type ModelUsageEvent,
  type ManagedFileRecord,
  type RunObservation,
  type WorkspaceCommand,
  type WorkspaceMembership,
  type WorkspaceAccessRequest,
  type WorkspaceFile,
  type UserIdentity,
  type UserRecord,
  type ServicePrincipalRecord,
  type StructuredDataResourceRecord,
  asAgentRunId,
  asConversationAttachmentId,
  asConversationId,
  asCollaborationWorkspaceId,
  asExecutionWorkspaceId,
  asManagedArtifactId,
  asManagedFileId,
  asMessageId,
  asToolCallId,
  asClientInstanceId,
  asUserId,
  isLocaleCode,
  asApiCredentialId,
  asServicePrincipalId,
  asStructuredDataResourceId,
  asWorkspaceCommandId,
  asWorkspaceAccessRequestId
} from "@work-shape/catalyst-core";
import type {
  approvalRequests,
  agentRunObservations,
  agentRuns,
  artifactPreviewJobs,
  artifactPreviewManifests,
  auditEvents,
  conversationAttachments,
  collaborationWorkspaces,
  collaborationWorkspaceMemberships,
  collaborationWorkspaceAccessRequests,
  conversations,
  configAssetRevisions,
  configAssets,
  configAssetState,
  executionWorkspaceFiles,
  executionWorkspaces,
  managedArtifacts,
  managedFiles,
  messages,
  modelUsageEvents,
  productUsers,
  apiCredentials,
  servicePrincipals,
  structuredDataResources,
  userIdentities,
  workspaceCommands
} from "./schema";

export type AgentRunRow = typeof agentRuns.$inferSelect;
export type ArtifactPreviewJobRow = typeof artifactPreviewJobs.$inferSelect;
export type ArtifactPreviewManifestRow = typeof artifactPreviewManifests.$inferSelect;
export type RunObservationRow = typeof agentRunObservations.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type CollaborationWorkspaceRow = typeof collaborationWorkspaces.$inferSelect;
export type WorkspaceMembershipRow = typeof collaborationWorkspaceMemberships.$inferSelect;
export type WorkspaceAccessRequestRow = typeof collaborationWorkspaceAccessRequests.$inferSelect;
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
export type ServicePrincipalRow = typeof servicePrincipals.$inferSelect;
export type ApiCredentialRow = typeof apiCredentials.$inferSelect;
export type UserIdentityRow = typeof userIdentities.$inferSelect;
export type ConfigAssetStateRow = typeof configAssetState.$inferSelect;
export type ConfigAssetRow = typeof configAssets.$inferSelect;
export type ConfigAssetRevisionRow = typeof configAssetRevisions.$inferSelect;
export type StructuredDataResourceRow = typeof structuredDataResources.$inferSelect;

/**
 * The rows of a Workflow `agent` step (CR-2) belong to no person and no workspace. No reader of
 * the conversation and run routes reaches one; the Workflow run's readers map them themselves.
 */
const AGENT_STEP_ROW_MESSAGE = "An agent step's run is read through its Workflow run";

export function mapConversation(row: ConversationRow | undefined): Conversation {
  if (!row) {
    throw new AppError("INTERNAL", "Expected conversation row");
  }
  const { collaborationWorkspaceId, createdByUserId, createdByExternalUserId } = row;
  if (
    collaborationWorkspaceId === null ||
    createdByUserId === null ||
    createdByExternalUserId === null
  ) {
    throw new AppError("INTERNAL", AGENT_STEP_ROW_MESSAGE);
  }
  return {
    id: asConversationId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    kind: row.kind,
    ...(row.parentConversationId === null
      ? {}
      : { parentConversationId: asConversationId(row.parentConversationId) }),
    collaborationWorkspaceId: asCollaborationWorkspaceId(collaborationWorkspaceId),
    createdByUserId,
    createdByExternalUserId,
    visibility: row.visibility,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    retainedUntil: row.retainedUntil.toISOString(),
    deletedAt: row.deletedAt?.toISOString(),
    ...(row.subjectKind === null || row.subjectName === null
      ? {}
      : { subject: { kind: row.subjectKind, name: row.subjectName } })
  };
}

export function mapCollaborationWorkspace(
  row: CollaborationWorkspaceRow | undefined
): CollaborationWorkspace {
  if (!row) {
    throw new AppError("INTERNAL", "Expected collaboration workspace row");
  }
  return {
    id: asCollaborationWorkspaceId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    kind: row.kind,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    defaultConversationVisibility: row.defaultConversationVisibility,
    emoji: row.emoji,
    accentColor: row.accentColor,
    personalUserId: row.personalUserId ? asUserId(row.personalUserId) : null,
    ...(row.allowedToolNames === null ? {} : { allowedToolNames: row.allowedToolNames }),
    ...(row.allowedModelBindingIds === null
      ? {}
      : { allowedModelBindingIds: row.allowedModelBindingIds }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function mapCollaborationWorkspaceWithRole(input: {
  workspace: CollaborationWorkspaceRow;
  role: WorkspaceMembership["role"];
}): CollaborationWorkspaceWithRole {
  return { ...mapCollaborationWorkspace(input.workspace), role: input.role };
}

export function mapWorkspaceMembership(
  row: WorkspaceMembershipRow | undefined
): WorkspaceMembership {
  if (!row) {
    throw new AppError("INTERNAL", "Expected workspace membership row");
  }
  return {
    collaborationWorkspaceId: asCollaborationWorkspaceId(row.collaborationWorkspaceId),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    userId: asUserId(row.userId),
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function mapWorkspaceAccessRequest(
  row: WorkspaceAccessRequestRow | undefined
): WorkspaceAccessRequest {
  if (!row) {
    throw new AppError("INTERNAL", "Expected workspace access request row");
  }
  return {
    id: asWorkspaceAccessRequestId(row.id),
    collaborationWorkspaceId: asCollaborationWorkspaceId(row.collaborationWorkspaceId),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    userId: asUserId(row.userId),
    createdAt: row.createdAt.toISOString()
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
    ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
    ...(row.principalId ? { principalId: row.principalId } : {}),
    ...(row.workflowStepRunId ? { workflowStepRunId: row.workflowStepRunId } : {}),
    ...(row.parentRunId === null ? {} : { parentRunId: asAgentRunId(row.parentRunId) }),
    inputMessageId: asMessageId(row.inputMessageId),
    agentName: row.agentName,
    modelBindingId: row.modelBindingId ?? undefined,
    reasoningEffort: row.reasoningEffort ?? undefined,
    locale: row.locale ?? undefined,
    authorization: row.authorizationContext ?? undefined,
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
    leaseToken: row.leaseToken ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString(),
    heartbeatAt: row.heartbeatAt?.toISOString(),
    cancellationRequestedAt: row.cancellationRequestedAt?.toISOString(),
    cancellationReason: row.cancellationReason ?? undefined
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
    ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
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
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString()
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
    ...(row.ownerKind !== null && row.ownerId !== null
      ? { owner: { kind: row.ownerKind, id: row.ownerId } }
      : {}),
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

export function mapArtifactPreviewJob(
  row: ArtifactPreviewJobRow | undefined
): ArtifactPreviewJobRecord {
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
    renderer: row.renderer,
    rendererVersion: row.rendererVersion,
    settingsHash: row.settingsHash,
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

export function mapStructuredDataResource(
  row: StructuredDataResourceRow | undefined
): StructuredDataResourceRecord {
  if (!row) {
    throw new AppError("INTERNAL", "Expected structured data resource row");
  }
  return {
    id: asStructuredDataResourceId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    conversationId: asConversationId(row.conversationId),
    resourceKey: row.resourceKey,
    title: row.title,
    state: row.state,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
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
    ...(row.actor ? { actor: row.actor } : {}),
    ...(row.subject === null ? {} : { subject: row.subject }),
    ...(row.reason === null ? {} : { reason: row.reason }),
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
    ...(row.workflowRunId ? { workflowRunId: row.workflowRunId } : {}),
    status: row.status,
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    ...(row.conversationId === null
      ? {}
      : { conversationId: asConversationId(row.conversationId) }),
    ...(row.agentRunId === null ? {} : { agentRunId: asAgentRunId(row.agentRunId) }),
    // A row holds the agent of its run or the purpose of a call the product made for itself.
    agentName: row.agentName ?? row.purpose ?? "",
    ...(row.purpose === null ? {} : { purpose: row.purpose }),
    providerId: row.providerId,
    model: row.model,
    ...(row.region === null ? {} : { region: row.region }),
    ...(row.bindingId === null ? {} : { bindingId: row.bindingId }),
    ...(row.userId === null ? {} : { userId: asUserId(row.userId) }),
    ...(row.collaborationWorkspaceId === null
      ? {}
      : { collaborationWorkspaceId: asCollaborationWorkspaceId(row.collaborationWorkspaceId) }),
    ...(row.operationRunId === null ? {} : { operationRunId: row.operationRunId }),
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens ?? undefined,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    webSearchCallCount: row.webSearchCallCount,
    fastMode: row.fastMode,
    ...(row.providerServiceTier === null ? {} : { providerServiceTier: row.providerServiceTier }),
    preview: row.preview,
    source: row.source,
    customerBillableCost:
      row.customerBillableCost ??
      ({
        status: "unpriced",
        source: "backfilled",
        calculationVersion: 1,
        missingMeters: ["model_rate"]
      } satisfies ModelUsageEvent["customerBillableCost"]),
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

/**
 * `permissions` is the user's legacy list as their instance-wide grant rows say it
 * (`legacy-permission-lists.ts`); the column of that name is no longer read.
 */
export function mapUserRecord(
  row: ProductUserRow | undefined,
  identities: UserIdentity[],
  permissions: string[]
): UserRecord {
  if (!row) {
    throw new AppError("INTERNAL", "Expected user row");
  }
  return {
    id: asUserId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    displayLabel: row.displayLabel,
    email: row.email ?? undefined,
    ...(row.groups.length ? { groups: row.groups } : {}),
    roles: row.roles,
    permissionRefs: row.permissionRefs,
    permissions,
    status: row.deletionRequestedAt ? "deleting" : row.status,
    // A language the release no longer ships reads as none: the default applies.
    ...(row.locale && isLocaleCode(row.locale) ? { locale: row.locale } : {}),
    ...(row.followUpMode === "steer" ? { followUpMode: "steer" as const } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastAuthenticatedAt: row.lastAuthenticatedAt?.toISOString(),
    identities
  };
}

/** `permissions` is the principal's legacy list as its instance-wide grant rows say it. */
export function mapServicePrincipal(
  row: ServicePrincipalRow | undefined,
  permissions: string[]
): ServicePrincipalRecord {
  if (!row) {
    throw new AppError("INTERNAL", "Expected service principal row");
  }
  return {
    id: asServicePrincipalId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    name: row.name,
    ...(row.ownerKind && row.ownerAssetId
      ? { owner: { kind: row.ownerKind, assetId: row.ownerAssetId } }
      : {}),
    displayLabel: row.displayLabel,
    description: row.description ?? undefined,
    status: row.status,
    permissionRefs: row.permissionRefs,
    permissions,
    createdByUserId: row.createdByUserId ? asUserId(row.createdByUserId) : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString()
  };
}

export function mapApiCredential(row: ApiCredentialRow | undefined): ApiCredentialRecord {
  if (!row?.servicePrincipalId) {
    throw new AppError("INTERNAL", "Expected the row of a service principal's API credential");
  }
  return {
    id: asApiCredentialId(row.id),
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    servicePrincipalId: asServicePrincipalId(row.servicePrincipalId),
    name: row.name,
    keyPrefix: row.keyPrefix,
    // `*` is every scope the principal has, which a record says by leaving the list out. A
    // list written before `*` meant that had it stripped by the migration that backfilled it.
    scopes: row.scopes === null || row.scopes.includes("*") ? undefined : row.scopes,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString()
  };
}

export function mapPersonalApiKey(row: ApiCredentialRow): PersonalApiKeyRecord {
  if (!row.ownerUserId || !row.expiresAt || !row.scopes) {
    throw new AppError("INTERNAL", "Expected the row of a personal API key");
  }
  return {
    id: asApiCredentialId(row.id),
    clientInstanceId: asClientInstanceId(row.clientInstanceId),
    ownerUserId: asUserId(row.ownerUserId),
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString()
  };
}

export function mapConfigAssetState(row: ConfigAssetStateRow | undefined): ConfigAssetState {
  if (!row) {
    return { version: 0 };
  }
  return {
    version: row.version,
    defaultAgentName: row.defaultAgentName ?? undefined
  };
}

export function mapAssetScope(row: Pick<ConfigAssetRow, "scopeKind" | "scopeId">): AssetScope {
  if (row.scopeKind === "instance") {
    return { kind: "instance" };
  }
  if (row.scopeId === null) {
    throw new AppError("INTERNAL", "A workspace-owned config asset names no workspace");
  }
  return { kind: "workspace", workspaceId: asCollaborationWorkspaceId(row.scopeId) };
}

export function mapConfigAsset(
  row: ConfigAssetRow | undefined,
  revision: ConfigAssetRevisionRow | undefined,
  /** The revision the published pointer names, where the reader joined it. */
  published?: Pick<ConfigAssetRevisionRow, "id" | "revision" | "fileSetId" | "config"> | null,
  appAvailability?: AppAvailability | null
): ConfigAssetRecord {
  if (!row || !revision || revision.id !== row.activeRevisionId) {
    throw new AppError("INTERNAL", "Expected config asset with its active revision");
  }
  if (published && published.id !== row.publishedRevisionId) {
    throw new AppError("INTERNAL", "Expected config asset with its published revision");
  }
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    kind: row.kind,
    name: row.name,
    scope: mapAssetScope(row),
    status: row.status,
    ...(appAvailability ? { appAvailability } : {}),
    activeRevisionId: row.activeRevisionId,
    revision: revision.revision,
    config: revision.config,
    ...(revision.fileSetId ? { fileSetId: revision.fileSetId } : {}),
    ...(revision.commit && revision.tree ? { commit: revision.commit, tree: revision.tree } : {}),
    ...(revision.origin ? { revisionOrigin: revision.origin } : {}),
    ...(row.publishedRevisionId ? { publishedRevisionId: row.publishedRevisionId } : {}),
    ...(published
      ? {
          publishedRevision: published.revision,
          ...(published.fileSetId ? { publishedFileSetId: published.fileSetId } : {}),
          ...(published.config ? { publishedConfig: published.config } : {})
        }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function mapConfigAssetRevision(
  row: ConfigAssetRevisionRow | undefined
): ConfigAssetRevisionRecord {
  if (!row) {
    throw new AppError("INTERNAL", "Expected config asset revision row");
  }
  return {
    id: row.id,
    assetId: row.assetId,
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    revision: row.revision,
    operation: row.operation,
    config: row.config,
    ...(row.fileSetId ? { fileSetId: row.fileSetId } : {}),
    ...(row.commit && row.tree ? { commit: row.commit, tree: row.tree } : {}),
    actor: row.actor,
    origin: row.origin ?? undefined,
    globalVersion: row.globalVersion,
    createdAt: row.createdAt.toISOString()
  };
}

export function mapApprovalRequest(row: typeof approvalRequests.$inferSelect): ApprovalRequest {
  let decision: ApprovalRequest["decision"];
  if (row.decision) {
    const { reversion: _reversion, ...storedDecision } = row.decision;
    decision = storedDecision;
  }
  return {
    ...row,
    clientInstanceId: row.clientInstanceId as ClientInstanceId,
    origin: row.origin ?? undefined,
    addresseeUserId: row.addresseeUserId ?? undefined,
    decision,
    reversion: row.decision?.reversion,
    applyResult: row.applyResult ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}
