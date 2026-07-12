import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Notice, Sql } from "postgres";
import {
  type AuditEvent,
  type AuditEventInput,
  type AuditEventStore,
  type ApiAccessStore,
  type ApiCredentialRecord,
  type ChatMessage,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type ConfigAssetState,
  type ConfigAssetStore,
  type Conversation,
  type ConversationId,
  type ConversationRetentionStore,
  type ConversationStore,
  type AgentRun,
  type AgentRunId,
  type AgentRunStore,
  type AppendRunObservationInput,
  type ClaimRunStartCommandInput,
  type ClaimRunStartCommandResult,
  type CompleteRunStartCommandInput,
  type CreateConversationInput,
  type CreateApiCredentialInput,
  type CreateServicePrincipalInput,
  type CreateMessageInput,
  type CreateUserInput,
  type DeleteUserInput,
  type DeleteUserIdentityInput,
  type ExecutionWorkspace,
  type ExecutionWorkspaceCleanupStore,
  type ExecutionWorkspaceFileStore,
  type ExecutionWorkspaceMetadataStore,
  type ExecutionWorkspaceId,
  type ModelUsageEvent,
  type ModelUsageEventInput,
  type ModelUsageEventStore,
  type ModelUsageWindowSummary,
  type PlatformFileStore,
  type ReleaseRunStartCommandInput,
  type ResolveUserIdentityInput,
  type RunObservation,
  type RunObservationStore,
  type UpdateUserInput,
  type UpdateAgentRunStatusInput,
  type UpsertUserIdentityInput,
  type UserRecord,
  type UserStore,
  type ServicePrincipalRecord,
  type UpdateServicePrincipalInput,
  type WorkspaceCommand,
  type WorkspaceCommandId,
  type WorkspaceCommandStore,
  type WorkspaceFile
} from "@vivd-catalyst/core";
import {
  createApiCredential as createPostgresApiCredential,
  createServicePrincipal as createPostgresServicePrincipal,
  listApiCredentials as listPostgresApiCredentials,
  listServicePrincipals as listPostgresServicePrincipals,
  resolveApiCredential as resolvePostgresApiCredential,
  revokeApiCredential as revokePostgresApiCredential,
  updateApiCredentialLastUsed as updatePostgresApiCredentialLastUsed,
  updateServicePrincipal as updatePostgresServicePrincipal
} from "./postgres-api-access-operations";
import {
  appendRunObservation as appendPostgresRunObservation,
  claimRunStartCommand as claimPostgresRunStartCommand,
  completeRunStartCommand as completePostgresRunStartCommand,
  createAgentRun as createPostgresAgentRun,
  getAgentRun as getPostgresAgentRun,
  getActiveConversationAgentRun as getPostgresActiveConversationAgentRun,
  getConversationAgentRun as getPostgresConversationAgentRun,
  listRunObservations as listPostgresRunObservations,
  prepareConversationRunStart as preparePostgresConversationRunStart,
  listStaleActiveAgentRuns as listPostgresStaleActiveAgentRuns,
  releaseRunStartCommand as releasePostgresRunStartCommand,
  recoverStaleAgentRun as recoverPostgresStaleAgentRun,
  updateAgentRunStatus as updatePostgresAgentRunStatus
} from "./postgres-agent-run-operations";
import {
  appendAuditEvent as appendPostgresAuditEvent,
  appendModelUsageEvent as appendPostgresModelUsageEvent,
  listAuditEvents as listPostgresAuditEvents,
  listModelUsageEvents as listPostgresModelUsageEvents,
  summarizeModelUsageEvents as summarizePostgresModelUsageEvents
} from "./postgres-audit-usage-operations";
import {
  applyConfigAssetMutations as applyPostgresConfigAssetMutations,
  getConfigAsset as getPostgresConfigAsset,
  getConfigAssetState as getPostgresConfigAssetState,
  listActiveConfigAssets as listActivePostgresConfigAssets,
  listConfigAssetRevisions as listPostgresConfigAssetRevisions
} from "./postgres-config-asset-operations";
import {
  appendMessage as appendPostgresMessage,
  createConversation as createPostgresConversation,
  deleteConversation as deletePostgresConversation,
  expireConversation as expirePostgresConversation,
  getConversation as getPostgresConversation,
  listConversationsForUser as listPostgresConversationsForUser,
  listExpiredConversations as listPostgresExpiredConversations,
  listMessages as listPostgresMessages,
  listRecentMessages as listPostgresRecentMessages,
  requireActiveConversation,
  touchConversation,
  updateConversationTitle as updatePostgresConversationTitle
} from "./postgres-conversation-operations";
import type { PostgresDatabase } from "./postgres-database";
import { createPostgresPlatformFileStore } from "./postgres-file-store";
import {
  cancelClaimedWorkspaceCommand as cancelClaimedPostgresWorkspaceCommand,
  claimNextWorkspaceCommand as claimNextPostgresWorkspaceCommand,
  completeWorkspaceCommand as completePostgresWorkspaceCommand,
  countActiveWorkspaceCommands as countActivePostgresWorkspaceCommands,
  deleteWorkspaceFile as deletePostgresWorkspaceFile,
  enqueueWorkspaceCommand as enqueuePostgresWorkspaceCommand,
  ensureExecutionWorkspace as ensurePostgresExecutionWorkspace,
  failWorkspaceCommand as failPostgresWorkspaceCommand,
  getExecutionWorkspace as getPostgresExecutionWorkspace,
  getExecutionWorkspaceForConversation as getPostgresExecutionWorkspaceForConversation,
  getWorkspaceCommand as getPostgresWorkspaceCommand,
  heartbeatWorkspaceCommand as heartbeatPostgresWorkspaceCommand,
  listExecutionWorkspaceCleanupTargets as listPostgresExecutionWorkspaceCleanupTargets,
  listExecutionWorkspaceObjectsForDeletion as listPostgresExecutionWorkspaceObjectsForDeletion,
  listWorkspaceFiles as listPostgresWorkspaceFiles,
  markExecutionWorkspaceDeleted as markPostgresExecutionWorkspaceDeleted,
  recoverStaleWorkspaceCommands as recoverStalePostgresWorkspaceCommands,
  requestWorkspaceCommandCancellation as requestPostgresWorkspaceCommandCancellation,
  upsertWorkspaceFile as upsertPostgresWorkspaceFile
} from "./postgres-execution-workspace-operations";
import { runPostgresMigrations } from "./migrations";
import {
  createUser as createPostgresUser,
  deleteUser as deletePostgresUser,
  deleteUserIdentity as deletePostgresUserIdentity,
  listUsers as listPostgresUsers,
  resolveUserIdentity as resolvePostgresUserIdentity,
  updateUser as updatePostgresUser,
  upsertUserIdentity as upsertPostgresUserIdentity
} from "./postgres-user-operations";
import { schema } from "./schema";

export interface PostgresPlatformStoreOptions {
  databaseUrl: string;
  runMigrations?: boolean;
}

const DUPLICATE_RELATION_NOTICE_CODE = "42P07";
const DUPLICATE_SCHEMA_NOTICE_CODE = "42P06";

function handlePostgresNotice(notice: Notice): void {
  if (
    (notice.code === DUPLICATE_RELATION_NOTICE_CODE ||
      notice.code === DUPLICATE_SCHEMA_NOTICE_CODE) &&
    notice.message?.includes("already exists, skipping")
  ) {
    return;
  }

  console.warn(notice);
}

export class PostgresPlatformStore
  implements
    ConversationStore,
    ConversationRetentionStore,
    PlatformFileStore,
    AgentRunStore,
    RunObservationStore,
    ExecutionWorkspaceMetadataStore,
    ExecutionWorkspaceFileStore,
    WorkspaceCommandStore,
    ExecutionWorkspaceCleanupStore,
    AuditEventStore,
    ModelUsageEventStore,
    UserStore,
    ApiAccessStore,
    ConfigAssetStore
{
  private readonly postgresClient: Sql;
  private readonly db: PostgresDatabase;
  private readonly fileStore: PlatformFileStore;

  private constructor(sql: Sql) {
    this.postgresClient = sql;
    this.db = drizzle(sql, { schema });
    this.fileStore = createPostgresPlatformFileStore(this.db, {
      requireActiveConversation: (clientInstanceId, conversationId) =>
        requireActiveConversation(this.db, clientInstanceId, conversationId),
      touchConversation: (clientInstanceId, conversationId, updatedAt) =>
        touchConversation(this.db, clientInstanceId, conversationId, updatedAt)
    });
  }

  static async connect(options: PostgresPlatformStoreOptions): Promise<PostgresPlatformStore> {
    const sql = postgres(options.databaseUrl, {
      max: 10,
      idle_timeout: 30,
      onnotice: handlePostgresNotice
    });
    const store = new PostgresPlatformStore(sql);
    if (options.runMigrations ?? true) {
      await store.migrate();
    }
    return store;
  }

  async close(): Promise<void> {
    await this.postgresClient.end();
  }

  async migrate(): Promise<void> {
    await runPostgresMigrations(this.postgresClient, this.db);
  }

  async getConfigAssetState(
    input: Parameters<ConfigAssetStore["getConfigAssetState"]>[0]
  ): Promise<ConfigAssetState> {
    return getPostgresConfigAssetState(this.db, input);
  }

  async listActiveConfigAssets(
    input: Parameters<ConfigAssetStore["listActiveConfigAssets"]>[0]
  ): Promise<ConfigAssetRecord[]> {
    return listActivePostgresConfigAssets(this.db, input);
  }

  async getConfigAsset(
    input: Parameters<ConfigAssetStore["getConfigAsset"]>[0]
  ): Promise<ConfigAssetRecord | undefined> {
    return getPostgresConfigAsset(this.db, input);
  }

  async listConfigAssetRevisions(
    input: Parameters<ConfigAssetStore["listConfigAssetRevisions"]>[0]
  ): Promise<ConfigAssetRevisionRecord[]> {
    return listPostgresConfigAssetRevisions(this.db, input);
  }

  async applyConfigAssetMutations(
    input: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]
  ): Promise<{ version: number }> {
    return applyPostgresConfigAssetMutations(this.db, input);
  }

  async resolveUserIdentity(input: ResolveUserIdentityInput) {
    return resolvePostgresUserIdentity(this.db, input, (event) => this.appendAuditEvent(event));
  }

  async listUsers(input: { clientInstanceId: ClientInstanceId }): Promise<UserRecord[]> {
    return listPostgresUsers(this.db, input);
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    return createPostgresUser(this.db, input);
  }

  async updateUser(input: UpdateUserInput): Promise<UserRecord> {
    return updatePostgresUser(this.db, input);
  }

  async deleteUser(input: DeleteUserInput): Promise<UserRecord> {
    return deletePostgresUser(this.db, input);
  }

  async upsertUserIdentity(input: UpsertUserIdentityInput): Promise<UserRecord> {
    return upsertPostgresUserIdentity(this.db, input);
  }

  async deleteUserIdentity(input: DeleteUserIdentityInput): Promise<UserRecord> {
    return deletePostgresUserIdentity(this.db, input);
  }

  async listServicePrincipals(
    input: Parameters<ApiAccessStore["listServicePrincipals"]>[0]
  ): Promise<ServicePrincipalRecord[]> {
    return listPostgresServicePrincipals(this.db, input);
  }

  async createServicePrincipal(
    input: CreateServicePrincipalInput
  ): Promise<ServicePrincipalRecord> {
    return createPostgresServicePrincipal(this.db, input);
  }

  async updateServicePrincipal(
    input: UpdateServicePrincipalInput
  ): Promise<ServicePrincipalRecord> {
    return updatePostgresServicePrincipal(this.db, input);
  }

  async listApiCredentials(
    input: Parameters<ApiAccessStore["listApiCredentials"]>[0]
  ): Promise<ApiCredentialRecord[]> {
    return listPostgresApiCredentials(this.db, input);
  }

  async createApiCredential(input: CreateApiCredentialInput) {
    return createPostgresApiCredential(this.db, input);
  }

  async revokeApiCredential(
    input: Parameters<ApiAccessStore["revokeApiCredential"]>[0]
  ): Promise<ApiCredentialRecord> {
    return revokePostgresApiCredential(this.db, input);
  }

  async resolveApiCredential(input: Parameters<ApiAccessStore["resolveApiCredential"]>[0]) {
    return resolvePostgresApiCredential(this.db, input);
  }

  async updateApiCredentialLastUsed(
    input: Parameters<ApiAccessStore["updateApiCredentialLastUsed"]>[0]
  ): Promise<ApiCredentialRecord> {
    return updatePostgresApiCredentialLastUsed(this.db, input);
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    return createPostgresConversation(this.db, input);
  }

  async getConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId
  ): Promise<Conversation | undefined> {
    return getPostgresConversation(this.db, clientInstanceId, conversationId);
  }

  async listConversationsForUser(input: {
    clientInstanceId: ClientInstanceId;
    ownerUserId: string;
  }): Promise<Conversation[]> {
    return listPostgresConversationsForUser(this.db, input);
  }

  async listExpiredConversations(input: {
    clientInstanceId: ClientInstanceId;
    now: string;
    limit: number;
  }): Promise<Conversation[]> {
    return listPostgresExpiredConversations(this.db, input);
  }

  async updateConversationTitle(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    title: string;
    updatedAt: string;
  }): Promise<Conversation> {
    return updatePostgresConversationTitle(this.db, input);
  }

  async appendMessage(input: CreateMessageInput): Promise<ChatMessage> {
    return appendPostgresMessage(this.db, input);
  }

  async listMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ChatMessage[]> {
    return listPostgresMessages(this.db, input);
  }

  async listRecentMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    limit: number;
  }): Promise<ChatMessage[]> {
    return listPostgresRecentMessages(this.db, input);
  }

  async claimRunStartCommand(input: ClaimRunStartCommandInput): Promise<ClaimRunStartCommandResult> {
    return claimPostgresRunStartCommand(this.db, input);
  }

  async completeRunStartCommand(input: CompleteRunStartCommandInput) {
    return completePostgresRunStartCommand(this.db, input);
  }

  async releaseRunStartCommand(input: ReleaseRunStartCommandInput): Promise<void> {
    return releasePostgresRunStartCommand(this.db, input);
  }

  async prepareConversationRunStart(input: Parameters<AgentRunStore["prepareConversationRunStart"]>[0]) {
    return preparePostgresConversationRunStart(this.db, input);
  }

  async createAgentRun(input: Parameters<AgentRunStore["createAgentRun"]>[0]): Promise<AgentRun> {
    return createPostgresAgentRun(this.db, input);
  }

  async getAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
  }): Promise<AgentRun | undefined> {
    return getPostgresAgentRun(this.db, input);
  }

  async getConversationAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    runId: AgentRunId;
  }): Promise<AgentRun | undefined> {
    return getPostgresConversationAgentRun(this.db, input);
  }

  async getActiveConversationAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    ownerUserId: string;
  }): Promise<AgentRun | undefined> {
    return getPostgresActiveConversationAgentRun(this.db, input);
  }

  async updateAgentRunStatus(input: UpdateAgentRunStatusInput): Promise<AgentRun> {
    return updatePostgresAgentRunStatus(this.db, input);
  }

  async listStaleActiveAgentRuns(input: Parameters<AgentRunStore["listStaleActiveAgentRuns"]>[0]) {
    return listPostgresStaleActiveAgentRuns(this.db, input);
  }

  async recoverStaleAgentRun(input: Parameters<AgentRunStore["recoverStaleAgentRun"]>[0]) {
    return recoverPostgresStaleAgentRun(this.db, input);
  }

  async appendRunObservation(input: AppendRunObservationInput): Promise<RunObservation> {
    return appendPostgresRunObservation(this.db, input);
  }

  async listRunObservations(input: Parameters<RunObservationStore["listRunObservations"]>[0]) {
    return listPostgresRunObservations(this.db, input);
  }

  async ensureExecutionWorkspace(
    input: Parameters<ExecutionWorkspaceMetadataStore["ensureExecutionWorkspace"]>[0]
  ): Promise<ExecutionWorkspace> {
    return ensurePostgresExecutionWorkspace(this.db, input);
  }

  async getExecutionWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
  }): Promise<ExecutionWorkspace | undefined> {
    return getPostgresExecutionWorkspace(this.db, input);
  }

  async getExecutionWorkspaceForConversation(
    input: Parameters<ExecutionWorkspaceMetadataStore["getExecutionWorkspaceForConversation"]>[0]
  ): Promise<ExecutionWorkspace | undefined> {
    return getPostgresExecutionWorkspaceForConversation(this.db, input);
  }

  async upsertWorkspaceFile(
    input: Parameters<ExecutionWorkspaceFileStore["upsertWorkspaceFile"]>[0]
  ): Promise<WorkspaceFile> {
    return upsertPostgresWorkspaceFile(this.db, input);
  }

  async deleteWorkspaceFile(
    input: Parameters<ExecutionWorkspaceFileStore["deleteWorkspaceFile"]>[0]
  ): Promise<WorkspaceFile | undefined> {
    return deletePostgresWorkspaceFile(this.db, input);
  }

  async listWorkspaceFiles(
    input: Parameters<ExecutionWorkspaceFileStore["listWorkspaceFiles"]>[0]
  ): Promise<WorkspaceFile[]> {
    return listPostgresWorkspaceFiles(this.db, input);
  }

  async countActiveWorkspaceCommands(
    input: Parameters<WorkspaceCommandStore["countActiveWorkspaceCommands"]>[0]
  ) {
    return countActivePostgresWorkspaceCommands(this.db, input);
  }

  async enqueueWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["enqueueWorkspaceCommand"]>[0]
  ): Promise<WorkspaceCommand> {
    return enqueuePostgresWorkspaceCommand(this.db, input);
  }

  async getWorkspaceCommand(input: {
    clientInstanceId: ClientInstanceId;
    commandId: WorkspaceCommandId;
  }): Promise<WorkspaceCommand | undefined> {
    return getPostgresWorkspaceCommand(this.db, input);
  }

  async claimNextWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["claimNextWorkspaceCommand"]>[0]
  ): Promise<WorkspaceCommand | undefined> {
    return claimNextPostgresWorkspaceCommand(this.db, input);
  }

  async completeWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["completeWorkspaceCommand"]>[0]
  ): Promise<WorkspaceCommand> {
    return completePostgresWorkspaceCommand(this.db, input);
  }

  async failWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["failWorkspaceCommand"]>[0]
  ): Promise<WorkspaceCommand> {
    return failPostgresWorkspaceCommand(this.db, input);
  }

  async requestWorkspaceCommandCancellation(
    input: Parameters<WorkspaceCommandStore["requestWorkspaceCommandCancellation"]>[0]
  ): Promise<WorkspaceCommand> {
    return requestPostgresWorkspaceCommandCancellation(this.db, input);
  }

  async cancelClaimedWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["cancelClaimedWorkspaceCommand"]>[0]
  ): Promise<WorkspaceCommand> {
    return cancelClaimedPostgresWorkspaceCommand(this.db, input);
  }

  async heartbeatWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["heartbeatWorkspaceCommand"]>[0]
  ): Promise<WorkspaceCommand> {
    return heartbeatPostgresWorkspaceCommand(this.db, input);
  }

  async recoverStaleWorkspaceCommands(
    input: Parameters<WorkspaceCommandStore["recoverStaleWorkspaceCommands"]>[0]
  ): Promise<WorkspaceCommand[]> {
    return recoverStalePostgresWorkspaceCommands(this.db, input);
  }

  async listExecutionWorkspaceCleanupTargets(
    input: Parameters<ExecutionWorkspaceCleanupStore["listExecutionWorkspaceCleanupTargets"]>[0]
  ) {
    return listPostgresExecutionWorkspaceCleanupTargets(this.db, input);
  }

  async listExecutionWorkspaceObjectsForDeletion(
    input: Parameters<ExecutionWorkspaceCleanupStore["listExecutionWorkspaceObjectsForDeletion"]>[0]
  ) {
    return listPostgresExecutionWorkspaceObjectsForDeletion(this.db, input);
  }

  async markExecutionWorkspaceDeleted(
    input: Parameters<ExecutionWorkspaceCleanupStore["markExecutionWorkspaceDeleted"]>[0]
  ) {
    return markPostgresExecutionWorkspaceDeleted(this.db, input);
  }

  async createManagedFile(input: Parameters<PlatformFileStore["createManagedFile"]>[0]) {
    return this.fileStore.createManagedFile(input);
  }

  async getManagedFile(input: Parameters<PlatformFileStore["getManagedFile"]>[0]) {
    return this.fileStore.getManagedFile(input);
  }

  async createManagedArtifact(input: Parameters<PlatformFileStore["createManagedArtifact"]>[0]) {
    return this.fileStore.createManagedArtifact(input);
  }

  async getManagedArtifact(input: Parameters<PlatformFileStore["getManagedArtifact"]>[0]) {
    return this.fileStore.getManagedArtifact(input);
  }

  async listManagedArtifactsForFile(
    input: Parameters<PlatformFileStore["listManagedArtifactsForFile"]>[0]
  ) {
    return this.fileStore.listManagedArtifactsForFile(input);
  }

  async enqueueArtifactPreviewJob(
    input: Parameters<PlatformFileStore["enqueueArtifactPreviewJob"]>[0]
  ) {
    return this.fileStore.enqueueArtifactPreviewJob(input);
  }

  async getArtifactPreviewJob(input: Parameters<PlatformFileStore["getArtifactPreviewJob"]>[0]) {
    return this.fileStore.getArtifactPreviewJob(input);
  }

  async claimNextArtifactPreviewJob(
    input: Parameters<PlatformFileStore["claimNextArtifactPreviewJob"]>[0]
  ) {
    return this.fileStore.claimNextArtifactPreviewJob(input);
  }

  async completeClaimedArtifactPreviewJob(
    input: Parameters<PlatformFileStore["completeClaimedArtifactPreviewJob"]>[0]
  ) {
    return this.fileStore.completeClaimedArtifactPreviewJob(input);
  }

  async failClaimedArtifactPreviewJob(
    input: Parameters<PlatformFileStore["failClaimedArtifactPreviewJob"]>[0]
  ) {
    return this.fileStore.failClaimedArtifactPreviewJob(input);
  }

  async markClaimedArtifactPreviewJobUnsupported(
    input: Parameters<PlatformFileStore["markClaimedArtifactPreviewJobUnsupported"]>[0]
  ) {
    return this.fileStore.markClaimedArtifactPreviewJobUnsupported(input);
  }

  async recoverStaleArtifactPreviewJobs(
    input: Parameters<PlatformFileStore["recoverStaleArtifactPreviewJobs"]>[0]
  ) {
    return this.fileStore.recoverStaleArtifactPreviewJobs(input);
  }

  async getArtifactPreviewManifest(
    input: Parameters<PlatformFileStore["getArtifactPreviewManifest"]>[0]
  ) {
    return this.fileStore.getArtifactPreviewManifest(input);
  }

  async writeArtifactPreviewManifest(
    input: Parameters<PlatformFileStore["writeArtifactPreviewManifest"]>[0]
  ) {
    return this.fileStore.writeArtifactPreviewManifest(input);
  }

  async createConversationAttachment(
    input: Parameters<PlatformFileStore["createConversationAttachment"]>[0]
  ) {
    return this.fileStore.createConversationAttachment(input);
  }

  async getConversationAttachment(
    input: Parameters<PlatformFileStore["getConversationAttachment"]>[0]
  ) {
    return this.fileStore.getConversationAttachment(input);
  }

  async listDraftAttachments(input: Parameters<PlatformFileStore["listDraftAttachments"]>[0]) {
    return this.fileStore.listDraftAttachments(input);
  }

  async updateConversationAttachment(
    input: Parameters<PlatformFileStore["updateConversationAttachment"]>[0]
  ) {
    return this.fileStore.updateConversationAttachment(input);
  }

  async deleteDraftAttachment(input: Parameters<PlatformFileStore["deleteDraftAttachment"]>[0]) {
    return this.fileStore.deleteDraftAttachment(input);
  }

  async claimReadyDraftAttachmentsForMessage(
    input: Parameters<PlatformFileStore["claimReadyDraftAttachmentsForMessage"]>[0]
  ) {
    return this.fileStore.claimReadyDraftAttachmentsForMessage(input);
  }

  async claimNextQueuedConversationAttachment(
    input: Parameters<PlatformFileStore["claimNextQueuedConversationAttachment"]>[0]
  ) {
    return this.fileStore.claimNextQueuedConversationAttachment(input);
  }

  async completeClaimedConversationAttachment(
    input: Parameters<PlatformFileStore["completeClaimedConversationAttachment"]>[0]
  ) {
    return this.fileStore.completeClaimedConversationAttachment(input);
  }

  async failClaimedConversationAttachment(
    input: Parameters<PlatformFileStore["failClaimedConversationAttachment"]>[0]
  ) {
    return this.fileStore.failClaimedConversationAttachment(input);
  }

  async findReadyConversationAttachmentByFile(
    input: Parameters<PlatformFileStore["findReadyConversationAttachmentByFile"]>[0]
  ) {
    return this.fileStore.findReadyConversationAttachmentByFile(input);
  }

  async findConversationAttachmentByFile(
    input: Parameters<PlatformFileStore["findConversationAttachmentByFile"]>[0]
  ) {
    return this.fileStore.findConversationAttachmentByFile(input);
  }

  async markConversationManagedObjectsDeleted(
    input: Parameters<PlatformFileStore["markConversationManagedObjectsDeleted"]>[0]
  ) {
    return this.fileStore.markConversationManagedObjectsDeleted(input);
  }

  async listConversationManagedObjectsForDeletion(
    input: Parameters<PlatformFileStore["listConversationManagedObjectsForDeletion"]>[0]
  ) {
    return this.fileStore.listConversationManagedObjectsForDeletion(input);
  }

  async deleteConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<Conversation> {
    return deletePostgresConversation(this.db, input);
  }

  async expireConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    expiredAt: string;
  }): Promise<Conversation> {
    return expirePostgresConversation(this.db, input);
  }

  async appendAuditEvent(input: AuditEventInput): Promise<AuditEvent> {
    return appendPostgresAuditEvent(this.db, input);
  }

  async listAuditEvents(input: {
    clientInstanceId: ClientInstanceId;
    limit?: number;
    type?: string;
  }): Promise<AuditEvent[]> {
    return listPostgresAuditEvents(this.db, input);
  }

  async appendModelUsageEvent(input: ModelUsageEventInput): Promise<ModelUsageEvent> {
    return appendPostgresModelUsageEvent(this.db, input);
  }

  async summarizeModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
  }): Promise<ModelUsageWindowSummary> {
    return summarizePostgresModelUsageEvents(this.db, input);
  }

  async listModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<ModelUsageEvent[]> {
    return listPostgresModelUsageEvents(this.db, input);
  }
}
