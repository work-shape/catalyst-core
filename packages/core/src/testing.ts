import {
  AppError,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventStore,
  type ChatMessage,
  type ClientInstanceId,
  type Conversation,
  type ConversationId,
  type ConversationRetentionStore,
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
} from "./index";
import {
  createInMemoryPlatformFileStore,
  type InMemoryPlatformFileStore
} from "./testing-in-memory-file-store";

export class InMemoryPlatformStore
  implements
    ConversationStore,
    ConversationRetentionStore,
    PlatformFileStore,
    AuditEventStore,
    ModelUsageEventStore,
    UserStore
{
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, ChatMessage[]>();
  private readonly fileStore: InMemoryPlatformFileStore =
    createInMemoryPlatformFileStore({
      requireActiveConversation: (clientInstanceId, conversationId) =>
        this.requireActiveConversation(clientInstanceId, conversationId),
      touchConversation: (conversationId, updatedAt) => this.touchConversation(conversationId, updatedAt)
    });
  private readonly auditEvents: AuditEvent[] = [];
  private readonly modelUsageEvents: ModelUsageEvent[] = [];
  private readonly users = new Map<string, UserRecord>();
  private readonly identities = new Map<string, UserIdentity>();

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: createPlatformId("conv"),
      clientInstanceId: input.clientInstanceId,
      ownerUserId: input.ownerUserId,
      ownerExternalUserId: input.ownerExternalUserId,
      title: input.title,
      status: "active",
      createdAt: now,
      updatedAt: now,
      retainedUntil: input.retainedUntil
    };
    this.conversations.set(conversation.id, conversation);
    this.messages.set(conversation.id, []);
    return conversation;
  }

  async getConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId
  ): Promise<Conversation | undefined> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.clientInstanceId !== clientInstanceId) {
      return undefined;
    }
    return conversation;
  }

  async listConversationsForUser(input: {
    clientInstanceId: ClientInstanceId;
    ownerUserId: string;
  }): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .filter(
        (conversation) =>
          conversation.clientInstanceId === input.clientInstanceId &&
          conversation.ownerUserId === input.ownerUserId &&
          conversation.status === "active"
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listExpiredConversations(input: {
    clientInstanceId: ClientInstanceId;
    now: string;
    limit: number;
  }): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .filter(
        (conversation) =>
          conversation.clientInstanceId === input.clientInstanceId &&
          conversation.status === "active" &&
          conversation.retainedUntil <= input.now
      )
      .sort((left, right) =>
        `${left.retainedUntil}:${left.id}`.localeCompare(`${right.retainedUntil}:${right.id}`)
      )
      .slice(0, input.limit);
  }

  async updateConversationTitle(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    title: string;
    updatedAt: string;
  }): Promise<Conversation> {
    const conversation = await this.getConversation(input.clientInstanceId, input.conversationId);
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }

    const updated: Conversation = {
      ...conversation,
      title: input.title,
      updatedAt: input.updatedAt
    };
    this.conversations.set(input.conversationId, updated);
    return updated;
  }

  async appendMessage(input: CreateMessageInput): Promise<ChatMessage> {
    const conversation = await this.getConversation(input.clientInstanceId, input.conversationId);
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }

    const message: ChatMessage = {
      id: input.id ?? createPlatformId("msg"),
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      role: input.role,
      text: input.text,
      createdAt: new Date().toISOString(),
      metadata: input.metadata
    };
    const messages = this.messages.get(input.conversationId) ?? [];
    messages.push(message);
    this.messages.set(input.conversationId, messages);
    this.conversations.set(input.conversationId, {
      ...conversation,
      updatedAt: message.createdAt
    });
    return message;
  }

  async listMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ChatMessage[]> {
    const conversation = await this.getConversation(input.clientInstanceId, input.conversationId);
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    return [...(this.messages.get(input.conversationId) ?? [])].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    );
  }

  async listRecentMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    limit: number;
  }): Promise<ChatMessage[]> {
    const messages = await this.listMessages(input);
    return messages.slice(-input.limit);
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
    return this.markConversationDeleted({
      ...input,
      status: "deleted"
    });
  }

  async expireConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    expiredAt: string;
  }): Promise<Conversation> {
    return this.markConversationDeleted({
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      deletedAt: input.expiredAt,
      status: "retention_expired"
    });
  }

  private async markConversationDeleted(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
    status: Conversation["status"];
  }): Promise<Conversation> {
    const conversation = await this.getConversation(input.clientInstanceId, input.conversationId);
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }

    const deleted: Conversation = {
      ...conversation,
      status: input.status,
      deletedAt: input.deletedAt,
      updatedAt: input.deletedAt
    };
    this.conversations.set(input.conversationId, deleted);
    this.messages.set(input.conversationId, []);
    this.fileStore.deleteAttachmentsForConversation(input);
    return deleted;
  }

  async appendAuditEvent(input: AuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      ...input,
      id: createPlatformId("audit"),
      createdAt: new Date().toISOString()
    };
    this.auditEvents.push(event);
    return event;
  }

  async listAuditEvents(input: {
    clientInstanceId: ClientInstanceId;
    limit?: number;
    type?: string;
  }): Promise<AuditEvent[]> {
    const limit = input.limit ?? 100;
    return this.auditEvents
      .filter(
        (event) =>
          event.clientInstanceId === input.clientInstanceId &&
          (!input.type || event.type === input.type)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async appendModelUsageEvent(input: ModelUsageEventInput): Promise<ModelUsageEvent> {
    const event: ModelUsageEvent = {
      ...input,
      id: createPlatformId("usage"),
      createdAt: new Date().toISOString()
    };
    this.modelUsageEvents.push(event);
    return event;
  }

  async summarizeModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
  }): Promise<ModelUsageWindowSummary> {
    const events = this.modelUsageEvents.filter(
      (event) =>
        event.clientInstanceId === input.clientInstanceId &&
        (!input.start || event.createdAt >= input.start) &&
        (!input.end || event.createdAt < input.end)
    );
    return summarizeEvents(events, input.start, input.end);
  }

  async listModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<ModelUsageEvent[]> {
    const events = this.modelUsageEvents
      .filter(
        (event) =>
          event.clientInstanceId === input.clientInstanceId &&
          (!input.start || event.createdAt >= input.start) &&
          (!input.end || event.createdAt < input.end)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return input.limit === undefined ? events : events.slice(0, input.limit);
  }

  async resolveUserIdentity(input: ResolveUserIdentityInput) {
    const identityKey = createIdentityKey(input);
    const now = new Date().toISOString();
    const existingIdentity = this.identities.get(identityKey);
    if (existingIdentity) {
      const user = this.users.get(existingIdentity.userId);
      if (!user || user.clientInstanceId !== input.clientInstanceId) {
        throw new AppError("INTERNAL", "User identity mapping points to a missing user");
      }
      const updatedIdentity: UserIdentity = {
        ...existingIdentity,
        displayLabel: input.displayLabel,
        email: input.email,
        emailVerified: input.emailVerified ?? false,
        updatedAt: now,
        lastAuthenticatedAt: now
      };
      const updatedUser: UserRecord = {
        ...user,
        updatedAt: now,
        lastAuthenticatedAt: now,
        identities: replaceIdentity(user.identities, updatedIdentity)
      };
      this.identities.set(identityKey, updatedIdentity);
      this.users.set(user.id, updatedUser);
      return authenticatedUserFromRecord({
        user: updatedUser,
        identity: updatedIdentity,
        correlationId: input.correlationId
      });
    }

    const { user, linkedByVerifiedEmail } = this.findOrCreateUserForIdentity(input, now);
    const identity: UserIdentity = {
      clientInstanceId: input.clientInstanceId,
      userId: user.id,
      authSource: input.authSource,
      externalUserId: input.externalUserId,
      displayLabel: input.displayLabel,
      email: input.email,
      emailVerified: input.emailVerified ?? false,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now
    };
    if (linkedByVerifiedEmail) {
      await this.appendAuditEvent({
        clientInstanceId: input.clientInstanceId,
        type: "user.identity_linked",
        status: "success",
        subject: user.id,
        correlationId: input.correlationId ?? createPlatformId("corr"),
        metadata: {
          authSource: input.authSource,
          externalUserId: input.externalUserId,
          matchedBy: "verified-email"
        }
      });
    }
    const updatedUser: UserRecord = {
      ...user,
      updatedAt: now,
      lastAuthenticatedAt: now,
      identities: replaceIdentity(user.identities, identity)
    };
    this.identities.set(identityKey, identity);
    this.users.set(updatedUser.id, updatedUser);
    return authenticatedUserFromRecord({
      user: updatedUser,
      identity,
      correlationId: input.correlationId
    });
  }

  async listUsers(input: { clientInstanceId: ClientInstanceId }): Promise<UserRecord[]> {
    return [...this.users.values()]
      .filter((user) => user.clientInstanceId === input.clientInstanceId)
      .map((user) => this.attachIdentities(user))
      .sort((left, right) => left.displayLabel.localeCompare(right.displayLabel));
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: createUserId(),
      clientInstanceId: input.clientInstanceId,
      displayLabel: input.displayLabel,
      email: input.email,
      roles: input.roles ?? ["user"],
      permissionRefs: input.permissionRefs ?? [],
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
      identities: []
    };
    this.users.set(user.id, user);
    return user;
  }

  async updateUser(input: UpdateUserInput): Promise<UserRecord> {
    const user = this.users.get(input.userId);
    if (!user || user.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("NOT_FOUND", "User is not available");
    }

    const updated: UserRecord = {
      ...user,
      displayLabel: input.displayLabel ?? user.displayLabel,
      email: input.email === undefined ? user.email : (input.email ?? undefined),
      roles: input.roles ?? user.roles,
      permissionRefs: input.permissionRefs ?? user.permissionRefs,
      status: input.status ?? user.status,
      updatedAt: new Date().toISOString()
    };
    this.users.set(updated.id, updated);
    return this.attachIdentities(updated);
  }

  async upsertUserIdentity(input: UpsertUserIdentityInput): Promise<UserRecord> {
    const user = this.users.get(input.userId);
    if (!user || user.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("NOT_FOUND", "User is not available");
    }

    const now = new Date().toISOString();
    const identityKey = createIdentityKey(input);
    const existingIdentity = this.identities.get(identityKey);
    const identity: UserIdentity = {
      clientInstanceId: input.clientInstanceId,
      userId: input.userId,
      authSource: input.authSource,
      externalUserId: input.externalUserId,
      displayLabel: input.displayLabel,
      email: input.email,
      emailVerified: input.emailVerified ?? false,
      createdAt: existingIdentity?.createdAt ?? now,
      updatedAt: now,
      lastAuthenticatedAt: existingIdentity?.lastAuthenticatedAt
    };
    this.identities.set(identityKey, identity);
    const updated: UserRecord = {
      ...user,
      updatedAt: now,
      identities: replaceIdentity(this.attachIdentities(user).identities, identity)
    };
    this.users.set(updated.id, updated);
    return updated;
  }

  async deleteUserIdentity(input: DeleteUserIdentityInput): Promise<UserRecord> {
    const user = this.users.get(input.userId);
    if (!user || user.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("NOT_FOUND", "User is not available");
    }

    const identityKey = createIdentityKey(input);
    if (!this.identities.delete(identityKey)) {
      throw new AppError("NOT_FOUND", "User identity mapping is not available");
    }
    const updated: UserRecord = {
      ...user,
      updatedAt: new Date().toISOString(),
      identities: this.getIdentitiesForUser(user)
    };
    this.users.set(updated.id, updated);
    return updated;
  }

  private touchConversation(conversationId: ConversationId, updatedAt: string): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return;
    }
    this.conversations.set(conversationId, {
      ...conversation,
      updatedAt
    });
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

  private findOrCreateUserForIdentity(
    input: ResolveUserIdentityInput,
    now: string
  ): { user: UserRecord; linkedByVerifiedEmail: boolean } {
    if (input.sourceUserId) {
      const existing = this.users.get(input.sourceUserId);
      if (existing?.clientInstanceId === input.clientInstanceId) {
        return { user: this.attachIdentities(existing), linkedByVerifiedEmail: false };
      }
    }

    const matchedByEmail = this.findSingleUserByVerifiedEmail(input);
    if (matchedByEmail) {
      return { user: this.attachIdentities(matchedByEmail), linkedByVerifiedEmail: true };
    }

    const user: UserRecord = {
      id: createUserId(),
      clientInstanceId: input.clientInstanceId,
      displayLabel: input.displayLabel,
      email: input.email,
      roles: input.roles,
      permissionRefs: input.permissionRefs,
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now,
      identities: []
    };
    this.users.set(user.id, user);
    return { user, linkedByVerifiedEmail: false };
  }

  private findSingleUserByVerifiedEmail(input: ResolveUserIdentityInput): UserRecord | undefined {
    const normalizedEmail = input.email?.trim().toLowerCase();
    if (!input.linkByVerifiedEmail || !normalizedEmail || !input.emailVerified) {
      return undefined;
    }

    const candidateIds = new Set<string>();
    for (const identity of this.identities.values()) {
      if (
        identity.clientInstanceId === input.clientInstanceId &&
        identity.emailVerified &&
        identity.email?.trim().toLowerCase() === normalizedEmail
      ) {
        candidateIds.add(identity.userId);
      }
    }
    for (const user of this.users.values()) {
      if (
        user.clientInstanceId === input.clientInstanceId &&
        user.email?.trim().toLowerCase() === normalizedEmail
      ) {
        candidateIds.add(user.id);
      }
    }

    if (candidateIds.size !== 1) {
      return undefined;
    }
    const candidateId = [...candidateIds][0];
    return candidateId ? this.users.get(candidateId) : undefined;
  }

  private attachIdentities(user: UserRecord): UserRecord {
    return {
      ...user,
      identities: this.getIdentitiesForUser(user)
    };
  }

  private getIdentitiesForUser(user: UserRecord): UserIdentity[] {
    return [...this.identities.values()]
      .filter(
        (identity) =>
          identity.clientInstanceId === user.clientInstanceId && identity.userId === user.id
      )
      .sort((left, right) =>
        `${left.authSource}:${left.externalUserId}`.localeCompare(
          `${right.authSource}:${right.externalUserId}`
        )
      );
  }
}

function createIdentityKey(input: {
  clientInstanceId: ClientInstanceId;
  authSource: string;
  externalUserId: string;
}): string {
  return `${input.clientInstanceId}:${input.authSource}:${input.externalUserId}`;
}

function replaceIdentity(identities: UserIdentity[], identity: UserIdentity): UserIdentity[] {
  return [
    ...identities.filter(
      (currentIdentity) =>
        currentIdentity.authSource !== identity.authSource ||
        currentIdentity.externalUserId !== identity.externalUserId
    ),
    identity
  ].sort((left, right) =>
    `${left.authSource}:${left.externalUserId}`.localeCompare(`${right.authSource}:${right.externalUserId}`)
  );
}

function summarizeEvents(
  events: ModelUsageEvent[],
  start: string | undefined,
  end: string | undefined
): ModelUsageWindowSummary {
  return events.reduce<ModelUsageWindowSummary>(
    (summary, event) => ({
      ...summary,
      modelCallCount: summary.modelCallCount + 1,
      inputTokens: summary.inputTokens + event.inputTokens,
      outputTokens: summary.outputTokens + event.outputTokens,
      totalTokens: summary.totalTokens + event.totalTokens
    }),
    {
      start,
      end,
      modelCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  );
}
