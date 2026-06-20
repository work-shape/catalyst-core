import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql as drizzleSql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Notice, Sql } from "postgres";
import {
  AppError,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventStore,
  type ChatMessage,
  type ClientInstanceId,
  type Conversation,
  type ConversationId,
  type ConversationStore,
  type CreateConversationInput,
  type CreateMessageInput,
  type PlatformFileStore,
  type ModelUsageEvent,
  type ModelUsageEventInput,
  type ModelUsageEventStore,
  type ModelUsageWindowSummary,
  type CreateUserInput,
  type DeleteUserIdentityInput,
  type ResolveUserIdentityInput,
  type UpdateUserInput,
  type UpsertUserIdentityInput,
  type UserIdentity,
  type UserRecord,
  type UserStore,
  authenticatedUserFromRecord,
  createUserId,
  createPlatformId
} from "@vivd-catalyst/core";
import { runPostgresMigrations } from "./migrations";
import {
  mapAuditEvent,
  mapConversation,
  mapMessage,
  mapModelUsageEvent,
  mapUserIdentity,
  mapUserRecord,
  type ProductUserRow,
  type UserIdentityRow
} from "./rows";
import {
  auditEvents,
  conversationAttachments,
  conversations,
  messages,
  modelUsageEvents,
  productUsers,
  schema,
  userIdentities
} from "./schema";
import { createPostgresPlatformFileStore } from "./postgres-file-store";

export interface PostgresPlatformStoreOptions {
  databaseUrl: string;
  runMigrations?: boolean;
}

const DUPLICATE_RELATION_NOTICE_CODE = "42P07";
const DUPLICATE_SCHEMA_NOTICE_CODE = "42P06";
type PostgresDatabase = PostgresJsDatabase<typeof schema>;

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
  implements ConversationStore, PlatformFileStore, AuditEventStore, ModelUsageEventStore, UserStore
{
  private readonly postgresClient: Sql;
  private readonly db: PostgresDatabase;
  private readonly fileStore: PlatformFileStore;

  private constructor(sql: Sql) {
    this.postgresClient = sql;
    this.db = drizzle(sql, { schema });
    this.fileStore = createPostgresPlatformFileStore(this.db, {
      requireActiveConversation: (clientInstanceId, conversationId) =>
        this.requireActiveConversation(clientInstanceId, conversationId),
      touchConversation: (clientInstanceId, conversationId, updatedAt) =>
        this.touchConversation(clientInstanceId, conversationId, updatedAt)
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
    const normalizedEmail = input.email?.trim().toLowerCase();
    const emailLinkingEnabled = Boolean(
      input.linkByVerifiedEmail && normalizedEmail && input.emailVerified
    );

    const resolved = await this.db.transaction(async (tx) => {
      const now = new Date();
      await acquireResolveLock(
        tx,
        `identity:${input.clientInstanceId}:${input.authSource}:${input.externalUserId}`
      );
      if (emailLinkingEnabled) {
        await acquireResolveLock(tx, `identity-email:${input.clientInstanceId}:${normalizedEmail}`);
      }

      const [existingIdentity] = await tx
        .select()
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.clientInstanceId, input.clientInstanceId),
            eq(userIdentities.authSource, input.authSource),
            eq(userIdentities.externalUserId, input.externalUserId)
          )
        )
        .limit(1);

      if (existingIdentity) {
        const [user] = await tx
          .select()
          .from(productUsers)
          .where(
            and(
              eq(productUsers.clientInstanceId, input.clientInstanceId),
              eq(productUsers.id, existingIdentity.userId)
            )
          )
          .limit(1);
        if (!user) {
          throw new AppError("INTERNAL", "User identity mapping points to a missing user");
        }
        if (user.status !== "active") {
          throw new AppError("FORBIDDEN", "User is disabled");
        }

        const [updatedIdentity] = await tx
          .update(userIdentities)
          .set({
            displayLabel: input.displayLabel,
            email: input.email ?? null,
            emailVerified: input.emailVerified ?? false,
            updatedAt: now,
            lastAuthenticatedAt: now
          })
          .where(
            and(
              eq(userIdentities.clientInstanceId, input.clientInstanceId),
              eq(userIdentities.authSource, input.authSource),
              eq(userIdentities.externalUserId, input.externalUserId)
            )
          )
          .returning();
        await tx
          .update(productUsers)
          .set({
            updatedAt: now,
            lastAuthenticatedAt: now
          })
          .where(
            and(
              eq(productUsers.clientInstanceId, input.clientInstanceId),
              eq(productUsers.id, existingIdentity.userId)
            )
          );

        return {
          userId: existingIdentity.userId,
          identity: mapUserIdentity(updatedIdentity),
          linkedByVerifiedEmail: false
        };
      }

      let user: ProductUserRow | undefined;
      if (input.sourceUserId) {
        const [existingUser] = await tx
          .select()
          .from(productUsers)
          .where(
            and(
              eq(productUsers.clientInstanceId, input.clientInstanceId),
              eq(productUsers.id, input.sourceUserId)
            )
          )
          .limit(1);
        user = existingUser;
      }

      let linkedByVerifiedEmail = false;
      if (!user && emailLinkingEnabled && normalizedEmail) {
        user = await findSingleUserByVerifiedEmail(tx, input.clientInstanceId, normalizedEmail);
        linkedByVerifiedEmail = user !== undefined;
      }

      if (user?.status === "disabled") {
        throw new AppError("FORBIDDEN", "User is disabled");
      }

      if (!user) {
        const [createdUser] = await tx
          .insert(productUsers)
          .values({
            id: createUserId(),
            clientInstanceId: input.clientInstanceId,
            displayLabel: input.displayLabel,
            email: input.email ?? null,
            roles: input.roles,
            permissionRefs: input.permissionRefs,
            status: "active",
            createdAt: now,
            updatedAt: now,
            lastAuthenticatedAt: now
          })
          .returning();
        user = createdUser;
      } else {
        const [updatedUser] = await tx
          .update(productUsers)
          .set({
            updatedAt: now,
            lastAuthenticatedAt: now
          })
          .where(
            and(
              eq(productUsers.clientInstanceId, input.clientInstanceId),
              eq(productUsers.id, user.id)
            )
          )
          .returning();
        user = updatedUser;
      }

      if (!user) {
        throw new AppError("INTERNAL", "Failed to resolve user identity");
      }

      const [identity] = await tx
        .insert(userIdentities)
        .values({
          clientInstanceId: input.clientInstanceId,
          userId: user.id,
          authSource: input.authSource,
          externalUserId: input.externalUserId,
          displayLabel: input.displayLabel,
          email: input.email ?? null,
          emailVerified: input.emailVerified ?? false,
          createdAt: now,
          updatedAt: now,
          lastAuthenticatedAt: now
        })
        .onConflictDoUpdate({
          target: [
            userIdentities.clientInstanceId,
            userIdentities.authSource,
            userIdentities.externalUserId
          ],
          set: {
            userId: user.id,
            displayLabel: input.displayLabel,
            email: input.email ?? null,
            emailVerified: input.emailVerified ?? false,
            updatedAt: now,
            lastAuthenticatedAt: now
          }
        })
        .returning();

      return {
        userId: user.id,
        identity: mapUserIdentity(identity),
        linkedByVerifiedEmail
      };
    });

    if (resolved.linkedByVerifiedEmail) {
      await this.appendAuditEvent({
        clientInstanceId: input.clientInstanceId,
        type: "user.identity_linked",
        status: "success",
        subject: resolved.userId,
        correlationId: input.correlationId ?? createPlatformId("corr"),
        metadata: {
          authSource: input.authSource,
          externalUserId: input.externalUserId,
          matchedBy: "verified-email"
        }
      });
    }

    const user = await this.getUserRecord(input.clientInstanceId, resolved.userId);
    if (!user) {
      throw new AppError("INTERNAL", "Resolved user is not available");
    }
    return authenticatedUserFromRecord({
      user,
      identity: resolved.identity,
      correlationId: input.correlationId
    });
  }

  async listUsers(input: { clientInstanceId: ClientInstanceId }): Promise<UserRecord[]> {
    const rows = await this.db
      .select()
      .from(productUsers)
      .where(eq(productUsers.clientInstanceId, input.clientInstanceId))
      .orderBy(asc(productUsers.displayLabel));
    if (rows.length === 0) {
      return [];
    }

    const identityRows = await this.db
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.clientInstanceId, input.clientInstanceId),
          inArray(
            userIdentities.userId,
            rows.map((row) => row.id)
          )
        )
      );
    return rows.map((row) => mapUserRecord(row, identitiesForUser(row, identityRows)));
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const now = new Date();
    const [row] = await this.db
      .insert(productUsers)
      .values({
        id: createUserId(),
        clientInstanceId: input.clientInstanceId,
        displayLabel: input.displayLabel,
        email: input.email ?? null,
        roles: input.roles ?? ["user"],
        permissionRefs: input.permissionRefs ?? [],
        status: input.status ?? "active",
        createdAt: now,
        updatedAt: now
      })
      .returning();
    return mapUserRecord(row, []);
  }

  async updateUser(input: UpdateUserInput): Promise<UserRecord> {
    const set: Partial<typeof productUsers.$inferInsert> = {
      updatedAt: new Date()
    };
    if (input.displayLabel !== undefined) {
      set.displayLabel = input.displayLabel;
    }
    if (input.email !== undefined) {
      set.email = input.email;
    }
    if (input.roles !== undefined) {
      set.roles = input.roles;
    }
    if (input.permissionRefs !== undefined) {
      set.permissionRefs = input.permissionRefs;
    }
    if (input.status !== undefined) {
      set.status = input.status;
    }

    const [row] = await this.db
      .update(productUsers)
      .set(set)
      .where(
        and(
          eq(productUsers.clientInstanceId, input.clientInstanceId),
          eq(productUsers.id, input.userId)
        )
      )
      .returning();
    if (!row) {
      throw new AppError("NOT_FOUND", "User is not available");
    }
    return this.requireUserRecord(input.clientInstanceId, row.id);
  }

  async upsertUserIdentity(input: UpsertUserIdentityInput): Promise<UserRecord> {
    const user = await this.getUserRecord(input.clientInstanceId, input.userId);
    if (!user) {
      throw new AppError("NOT_FOUND", "User is not available");
    }

    const now = new Date();
    await this.db
      .insert(userIdentities)
      .values({
        clientInstanceId: input.clientInstanceId,
        userId: input.userId,
        authSource: input.authSource,
        externalUserId: input.externalUserId,
        displayLabel: input.displayLabel ?? null,
        email: input.email ?? null,
        emailVerified: input.emailVerified ?? false,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [
          userIdentities.clientInstanceId,
          userIdentities.authSource,
          userIdentities.externalUserId
        ],
        set: {
          userId: input.userId,
          displayLabel: input.displayLabel ?? null,
          email: input.email ?? null,
          emailVerified: input.emailVerified ?? false,
          updatedAt: now
        }
      });
    await this.db
      .update(productUsers)
      .set({ updatedAt: now })
      .where(
        and(
          eq(productUsers.clientInstanceId, input.clientInstanceId),
          eq(productUsers.id, input.userId)
        )
      );
    return this.requireUserRecord(input.clientInstanceId, input.userId);
  }

  async deleteUserIdentity(input: DeleteUserIdentityInput): Promise<UserRecord> {
    const user = await this.getUserRecord(input.clientInstanceId, input.userId);
    if (!user) {
      throw new AppError("NOT_FOUND", "User is not available");
    }

    const rows = await this.db
      .delete(userIdentities)
      .where(
        and(
          eq(userIdentities.clientInstanceId, input.clientInstanceId),
          eq(userIdentities.userId, input.userId),
          eq(userIdentities.authSource, input.authSource),
          eq(userIdentities.externalUserId, input.externalUserId)
        )
      )
      .returning();
    if (rows.length === 0) {
      throw new AppError("NOT_FOUND", "User identity mapping is not available");
    }
    await this.db
      .update(productUsers)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(productUsers.clientInstanceId, input.clientInstanceId),
          eq(productUsers.id, input.userId)
        )
      );
    return this.requireUserRecord(input.clientInstanceId, input.userId);
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const id = createPlatformId<"ConversationId">("conv");
    const now = new Date();
    const [row] = await this.db
      .insert(conversations)
      .values({
        id,
        clientInstanceId: input.clientInstanceId,
        ownerUserId: input.ownerUserId,
        ownerExternalUserId: input.ownerExternalUserId,
        title: input.title,
        status: "active",
        createdAt: now,
        updatedAt: now,
        retainedUntil: new Date(input.retainedUntil)
      })
      .returning();
    return mapConversation(row);
  }

  async getConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId
  ): Promise<Conversation | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.clientInstanceId, clientInstanceId), eq(conversations.id, conversationId)))
      .limit(1);
    return row ? mapConversation(row) : undefined;
  }

  async listConversationsForUser(input: {
    clientInstanceId: ClientInstanceId;
    ownerUserId: string;
  }): Promise<Conversation[]> {
    const rows = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.ownerUserId, input.ownerUserId),
          eq(conversations.status, "active")
        )
      )
      .orderBy(desc(conversations.updatedAt));
    return rows.map(mapConversation);
  }

  async updateConversationTitle(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    title: string;
    updatedAt: string;
  }): Promise<Conversation> {
    const [row] = await this.db
      .update(conversations)
      .set({
        title: input.title,
        updatedAt: new Date(input.updatedAt)
      })
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.id, input.conversationId),
          eq(conversations.status, "active")
        )
      )
      .returning();
    if (!row) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    return mapConversation(row);
  }

  async appendMessage(input: CreateMessageInput): Promise<ChatMessage> {
    const conversation = await this.getConversation(input.clientInstanceId, input.conversationId);
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }

    const id = input.id ?? createPlatformId<"MessageId">("msg");
    const createdAt = new Date();
    const [row] = await this.db
      .insert(messages)
      .values({
        id,
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        role: input.role,
        text: input.text,
        createdAt,
        metadata: input.metadata ?? {}
      })
      .returning();
    await this.db
      .update(conversations)
      .set({ updatedAt: createdAt })
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.id, input.conversationId)
        )
      );
    return mapMessage(row);
  }

  async listMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ChatMessage[]> {
    const conversation = await this.getConversation(input.clientInstanceId, input.conversationId);
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }

    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.clientInstanceId, input.clientInstanceId),
          eq(messages.conversationId, input.conversationId)
        )
      )
      .orderBy(asc(messages.createdAt));
    return rows.map(mapMessage);
  }

  async listRecentMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    limit: number;
  }): Promise<ChatMessage[]> {
    const conversation = await this.getConversation(input.clientInstanceId, input.conversationId);
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }

    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.clientInstanceId, input.clientInstanceId),
          eq(messages.conversationId, input.conversationId)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(input.limit);
    return rows.map(mapMessage).reverse();
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

  async deleteConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<Conversation> {
    const deletedAt = new Date(input.deletedAt);
    await this.db
      .update(conversationAttachments)
      .set({
        status: "deleted",
        deletedAt,
        updatedAt: deletedAt
      })
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          eq(conversationAttachments.conversationId, input.conversationId),
          ne(conversationAttachments.status, "deleted")
        )
      );
    await this.db
      .delete(messages)
      .where(
        and(
          eq(messages.clientInstanceId, input.clientInstanceId),
          eq(messages.conversationId, input.conversationId)
        )
      );
    const [row] = await this.db
      .update(conversations)
      .set({
        status: "deleted",
        deletedAt,
        updatedAt: deletedAt
      })
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.id, input.conversationId)
        )
      )
      .returning();
    if (!row) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    return mapConversation(row);
  }

  async appendAuditEvent(input: AuditEventInput): Promise<AuditEvent> {
    const id = createPlatformId<"AuditEventId">("audit");
    const [row] = await this.db
      .insert(auditEvents)
      .values({
        id,
        clientInstanceId: input.clientInstanceId,
        type: input.type,
        status: input.status,
        actor: input.actor ?? null,
        subject: input.subject ?? null,
        reason: input.reason ?? null,
        correlationId: input.correlationId,
        createdAt: new Date(),
        metadata: input.metadata ?? {}
      })
      .returning();
    return mapAuditEvent(row);
  }

  async listAuditEvents(input: {
    clientInstanceId: ClientInstanceId;
    limit?: number;
    type?: string;
  }): Promise<AuditEvent[]> {
    const limit = input.limit ?? 100;
    const filters = input.type
      ? and(eq(auditEvents.clientInstanceId, input.clientInstanceId), eq(auditEvents.type, input.type))
      : eq(auditEvents.clientInstanceId, input.clientInstanceId);
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(filters)
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    return rows.map(mapAuditEvent);
  }

  async appendModelUsageEvent(input: ModelUsageEventInput): Promise<ModelUsageEvent> {
    const id = createPlatformId<"ModelUsageEventId">("usage");
    const [row] = await this.db
      .insert(modelUsageEvents)
      .values({
        id,
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        agentRunId: input.agentRunId,
        agentName: input.agentName,
        providerId: input.providerId,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        totalTokens: input.totalTokens,
        source: input.source,
        correlationId: input.correlationId,
        createdAt: new Date()
      })
      .returning();
    return mapModelUsageEvent(row);
  }

  async summarizeModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
  }): Promise<ModelUsageWindowSummary> {
    const [row] = await this.db
      .select({
        modelCallCount: drizzleSql<number>`count(*)::int`,
        inputTokens: drizzleSql<number>`coalesce(sum(${modelUsageEvents.inputTokens}), 0)::int`,
        outputTokens: drizzleSql<number>`coalesce(sum(${modelUsageEvents.outputTokens}), 0)::int`,
        totalTokens: drizzleSql<number>`coalesce(sum(${modelUsageEvents.totalTokens}), 0)::int`
      })
      .from(modelUsageEvents)
      .where(and(...modelUsageFilters(input)));

    return {
      start: input.start,
      end: input.end,
      modelCallCount: row?.modelCallCount ?? 0,
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      totalTokens: row?.totalTokens ?? 0
    };
  }

  async listModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<ModelUsageEvent[]> {
    const query = this.db
      .select()
      .from(modelUsageEvents)
      .where(and(...modelUsageFilters(input)))
      .orderBy(desc(modelUsageEvents.createdAt));
    const rows = input.limit === undefined ? await query : await query.limit(input.limit);
    return rows.map(mapModelUsageEvent);
  }

  private async getUserRecord(
    clientInstanceId: ClientInstanceId,
    userId: string
  ): Promise<UserRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(productUsers)
      .where(and(eq(productUsers.clientInstanceId, clientInstanceId), eq(productUsers.id, userId)))
      .limit(1);
    if (!row) {
      return undefined;
    }
    const identityRows = await this.db
      .select()
      .from(userIdentities)
      .where(
        and(eq(userIdentities.clientInstanceId, clientInstanceId), eq(userIdentities.userId, userId))
      );
    return mapUserRecord(row, identityRows.map(mapUserIdentity));
  }

  private async requireUserRecord(clientInstanceId: ClientInstanceId, userId: string): Promise<UserRecord> {
    const user = await this.getUserRecord(clientInstanceId, userId);
    if (!user) {
      throw new AppError("NOT_FOUND", "User is not available");
    }
    return user;
  }

  private async requireActiveConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId
  ): Promise<void> {
    const conversation = await this.getConversation(clientInstanceId, conversationId);
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
  }

  private async touchConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId,
    updatedAt: Date
  ): Promise<void> {
    await this.db
      .update(conversations)
      .set({ updatedAt })
      .where(and(eq(conversations.clientInstanceId, clientInstanceId), eq(conversations.id, conversationId)));
  }
}

type PostgresTransaction = Parameters<Parameters<PostgresDatabase["transaction"]>[0]>[0];

async function acquireResolveLock(tx: PostgresTransaction, key: string): Promise<void> {
  await tx.execute(drizzleSql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function findSingleUserByVerifiedEmail(
  tx: PostgresTransaction,
  clientInstanceId: ClientInstanceId,
  normalizedEmail: string
): Promise<ProductUserRow | undefined> {
  const identityMatches = await tx
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.clientInstanceId, clientInstanceId),
        eq(userIdentities.emailVerified, true),
        drizzleSql`lower(${userIdentities.email}) = ${normalizedEmail}`
      )
    );
  const userMatches = await tx
    .select()
    .from(productUsers)
    .where(
      and(
        eq(productUsers.clientInstanceId, clientInstanceId),
        drizzleSql`lower(${productUsers.email}) = ${normalizedEmail}`
      )
    );

  const candidateIds = new Set<string>([
    ...identityMatches.map((match) => match.userId),
    ...userMatches.map((match) => match.id)
  ]);
  if (candidateIds.size !== 1) {
    return undefined;
  }

  const candidateId = [...candidateIds][0];
  if (!candidateId) {
    return undefined;
  }
  const matchedUser = userMatches.find((match) => match.id === candidateId);
  if (matchedUser) {
    return matchedUser;
  }

  const [row] = await tx
    .select()
    .from(productUsers)
    .where(
      and(eq(productUsers.clientInstanceId, clientInstanceId), eq(productUsers.id, candidateId))
    )
    .limit(1);
  return row;
}

function identitiesForUser(user: ProductUserRow, identities: UserIdentityRow[]): UserIdentity[] {
  return identities
    .filter((identity) => identity.userId === user.id)
    .map(mapUserIdentity)
    .sort((left, right) =>
      `${left.authSource}:${left.externalUserId}`.localeCompare(`${right.authSource}:${right.externalUserId}`)
    );
}

function modelUsageFilters(input: {
  clientInstanceId: ClientInstanceId;
  start?: string;
  end?: string;
}) {
  return [
    eq(modelUsageEvents.clientInstanceId, input.clientInstanceId),
    ...(input.start ? [gte(modelUsageEvents.createdAt, new Date(input.start))] : []),
    ...(input.end ? [lt(modelUsageEvents.createdAt, new Date(input.end))] : [])
  ];
}
