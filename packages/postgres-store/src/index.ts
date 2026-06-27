import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Notice, Sql } from "postgres";
import {
  type AuditEvent,
  type AuditEventInput,
  type AuditEventStore,
  type ChatMessage,
  type ClientInstanceId,
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
  type CreateMessageInput,
  type CreateUserInput,
  type DeleteUserIdentityInput,
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
  type UserStore
} from "@vivd-catalyst/core";
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
  releaseRunStartCommand as releasePostgresRunStartCommand,
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
import { runPostgresMigrations } from "./migrations";
import {
  createUser as createPostgresUser,
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
    AuditEventStore,
    ModelUsageEventStore,
    UserStore
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

  async upsertUserIdentity(input: UpsertUserIdentityInput): Promise<UserRecord> {
    return upsertPostgresUserIdentity(this.db, input);
  }

  async deleteUserIdentity(input: DeleteUserIdentityInput): Promise<UserRecord> {
    return deletePostgresUserIdentity(this.db, input);
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

  async appendRunObservation(input: AppendRunObservationInput): Promise<RunObservation> {
    return appendPostgresRunObservation(this.db, input);
  }

  async listRunObservations(input: Parameters<RunObservationStore["listRunObservations"]>[0]) {
    return listPostgresRunObservations(this.db, input);
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
