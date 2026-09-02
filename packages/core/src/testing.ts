import {
  AppError,
  type AgentRun,
  type AgentRunId,
  type AgentRunStore,
  type AppendClaimedAgentRunMessageInput,
  type AppendClaimedRunObservationInput,
  type AppendAssistantMessageInput,
  type AppendRunObservationInput,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventStore,
  type ApiAccessStore,
  type ApiCredentialRecord,
  type ChatMessage,
  type AssertClaimedAgentRunInput,
  type ClaimAgentRunInput,
  type ClaimRunStartCommandInput,
  type ClaimRunStartCommandResult,
  type ClientInstanceId,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type CollaborationWorkspaceStore,
  type CollaborationWorkspaceWithRole,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type ConfigAssetSource,
  type ConfigAssetState,
  type ConfigAssetStore,
  type RuntimeAssetSnapshot,
  type CompleteRunStartCommandInput,
  type Conversation,
  type ConversationId,
  type ConversationRetentionStore,
  type ConversationStore,
  type ModelProviderContinuationCheckpoint,
  type ModelProviderContinuationStore,
  type CreateAgentRunInput,
  type CreateConversationInput,
  type CreateWorkspaceInput,
  type CreateMessageInput,
  type HeartbeatAgentRunInput,
  type ExecutionWorkspaceCleanupStore,
  type ExecutionWorkspaceFileStore,
  type ExecutionWorkspaceMetadataStore,
  type PlatformFileStore,
  type PrepareConversationRunStartInput,
  type PreparedConversationRunStart,
  type ReleaseRunStartCommandInput,
  type RecoverStaleAgentRunInput,
  type RecoverStaleAgentRunResult,
  type RecoverExpiredAgentRunsInput,
  type RequestAgentRunCancellationInput,
  type RunObservation,
  type RunObservationStore,
  type RunStartCommand,
  type ModelUsageEvent,
  type ModelUsageEventRecordInput,
  type ModelUsageEventStore,
  type ModelUsageWindowSummary,
  type CreateUserInput,
  type DeleteUserInput,
  type DeleteUserIdentityInput,
  type ResolveUserIdentityInput,
  type UpdateUserInput,
  type UpdateAgentRunStatusInput,
  type UpsertUserIdentityInput,
  type UserIdentity,
  type UserRecord,
  type UserStore,
  type UpdateWorkspaceInput,
  type ServicePrincipalRecord,
  type StructuredDataResourceRecord,
  type StructuredDataStore,
  type WorkspaceCommandStore,
  type WorkspaceMembership,
  type WorkspaceMemberCandidate,
  type WorkspaceAccessRequest,
  authenticatedUserFromRecord,
  asUserId,
  createCollaborationWorkspaceId,
  createUserId,
  createPlatformId,
  createWorkspaceAccessRequestId,
  validateWorkspaceCreation
} from "./index";
import { InMemoryApiAccessStore } from "./testing-in-memory-api-access-store";
import type { AgentConfig, SkillConfig } from "./config";
import { InMemoryConfigAssetStore } from "./testing-in-memory-config-asset-store";
import {
  createInMemoryExecutionWorkspaceStore,
  type InMemoryExecutionWorkspaceStore
} from "./testing-in-memory-execution-workspace-store";
import {
  createInMemoryPlatformFileStore,
  type InMemoryPlatformFileStore
} from "./testing-in-memory-file-store";

export class InMemoryPlatformStore
  implements
    ConversationStore,
    ConversationRetentionStore,
    ModelProviderContinuationStore,
    CollaborationWorkspaceStore,
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
    ConfigAssetStore,
    StructuredDataStore
{
  private readonly conversations = new Map<string, Conversation>();
  private readonly collaborationWorkspaces = new Map<string, CollaborationWorkspace>();
  private readonly workspaceMemberships = new Map<string, WorkspaceMembership>();
  private readonly workspaceAccessRequests = new Map<string, WorkspaceAccessRequest>();
  private readonly messages = new Map<string, ChatMessage[]>();
  private readonly modelProviderContinuations = new Map<
    string,
    ModelProviderContinuationCheckpoint
  >();
  private readonly structuredDataResources = new Map<string, StructuredDataResourceRecord>();
  private readonly fileStore: InMemoryPlatformFileStore = createInMemoryPlatformFileStore({
    requireActiveConversation: (clientInstanceId, conversationId) =>
      this.requireActiveConversation(clientInstanceId, conversationId),
    touchConversation: (conversationId, updatedAt) =>
      this.touchConversation(conversationId, updatedAt)
  });
  private readonly auditEvents: AuditEvent[] = [];
  private readonly agentRuns = new Map<string, AgentRun>();
  private readonly runStartCommands = new Map<string, RunStartCommand>();
  private readonly runObservations = new Map<string, RunObservation[]>();
  private readonly executionWorkspaceStore: InMemoryExecutionWorkspaceStore =
    createInMemoryExecutionWorkspaceStore({
      requireActiveConversation: (clientInstanceId, conversationId) =>
        this.requireActiveConversation(clientInstanceId, conversationId),
      isConversationActive: async (clientInstanceId, conversationId) => {
        const conversation = await this.getConversation(clientInstanceId, conversationId);
        return conversation?.status === "active";
      }
    });
  private readonly modelUsageEvents: ModelUsageEvent[] = [];
  private readonly users = new Map<string, UserRecord>();
  private readonly identities = new Map<string, UserIdentity>();
  private readonly apiAccessStore = new InMemoryApiAccessStore({
    isUserInClient: ({ clientInstanceId, userId }) => {
      const user = this.users.get(userId);
      return user?.clientInstanceId === clientInstanceId;
    }
  });
  private readonly configAssetStore = new InMemoryConfigAssetStore();

  async getStructuredDataResource(
    input: Parameters<StructuredDataStore["getStructuredDataResource"]>[0]
  ): Promise<StructuredDataResourceRecord | undefined> {
    const resource = this.structuredDataResources.get(input.structuredDataResourceId);
    return resource?.clientInstanceId === input.clientInstanceId &&
      resource.conversationId === input.conversationId
      ? resource
      : undefined;
  }

  async listStructuredDataResources(
    input: Parameters<StructuredDataStore["listStructuredDataResources"]>[0]
  ): Promise<StructuredDataResourceRecord[]> {
    return [...this.structuredDataResources.values()]
      .filter(
        (resource) =>
          resource.clientInstanceId === input.clientInstanceId &&
          resource.conversationId === input.conversationId
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async publishStructuredDataResource(
    input: Parameters<StructuredDataStore["publishStructuredDataResource"]>[0]
  ): Promise<StructuredDataResourceRecord> {
    const existing = [...this.structuredDataResources.values()].find(
      (resource) =>
        resource.clientInstanceId === input.clientInstanceId &&
        resource.conversationId === input.conversationId &&
        resource.resourceKey === input.resourceKey
    );
    const now = new Date().toISOString();
    const resource: StructuredDataResourceRecord = {
      id: existing?.id ?? createPlatformId("sdr"),
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      resourceKey: input.resourceKey,
      title: input.title,
      state: input.state,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.structuredDataResources.set(resource.id, resource);
    return resource;
  }

  async getConfigAssetState(
    input: Parameters<ConfigAssetStore["getConfigAssetState"]>[0]
  ): Promise<ConfigAssetState> {
    return this.configAssetStore.getConfigAssetState(input);
  }

  async listActiveConfigAssets(
    input: Parameters<ConfigAssetStore["listActiveConfigAssets"]>[0]
  ): Promise<ConfigAssetRecord[]> {
    return this.configAssetStore.listActiveConfigAssets(input);
  }

  async getConfigAsset(
    input: Parameters<ConfigAssetStore["getConfigAsset"]>[0]
  ): Promise<ConfigAssetRecord | undefined> {
    return this.configAssetStore.getConfigAsset(input);
  }

  async listConfigAssetRevisions(
    input: Parameters<ConfigAssetStore["listConfigAssetRevisions"]>[0]
  ): Promise<ConfigAssetRevisionRecord[]> {
    return this.configAssetStore.listConfigAssetRevisions(input);
  }

  async applyConfigAssetMutations(
    input: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]
  ): Promise<{ version: number }> {
    return this.configAssetStore.applyConfigAssetMutations(input);
  }

  async listServicePrincipals(
    input: Parameters<ApiAccessStore["listServicePrincipals"]>[0]
  ): Promise<ServicePrincipalRecord[]> {
    return this.apiAccessStore.listServicePrincipals(input);
  }

  async createServicePrincipal(
    input: Parameters<ApiAccessStore["createServicePrincipal"]>[0]
  ): Promise<ServicePrincipalRecord> {
    return this.apiAccessStore.createServicePrincipal(input);
  }

  async updateServicePrincipal(
    input: Parameters<ApiAccessStore["updateServicePrincipal"]>[0]
  ): Promise<ServicePrincipalRecord> {
    return this.apiAccessStore.updateServicePrincipal(input);
  }

  async listApiCredentials(
    input: Parameters<ApiAccessStore["listApiCredentials"]>[0]
  ): Promise<ApiCredentialRecord[]> {
    return this.apiAccessStore.listApiCredentials(input);
  }

  async createApiCredential(input: Parameters<ApiAccessStore["createApiCredential"]>[0]) {
    return this.apiAccessStore.createApiCredential(input);
  }

  async revokeApiCredential(
    input: Parameters<ApiAccessStore["revokeApiCredential"]>[0]
  ): Promise<ApiCredentialRecord> {
    return this.apiAccessStore.revokeApiCredential(input);
  }

  async resolveApiCredential(input: Parameters<ApiAccessStore["resolveApiCredential"]>[0]) {
    return this.apiAccessStore.resolveApiCredential(input);
  }

  async updateApiCredentialLastUsed(
    input: Parameters<ApiAccessStore["updateApiCredentialLastUsed"]>[0]
  ): Promise<ApiCredentialRecord> {
    return this.apiAccessStore.updateApiCredentialLastUsed(input);
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<CollaborationWorkspace> {
    validateWorkspaceCreation(input);
    this.requireUser(input.clientInstanceId, input.creatorUserId);
    if (
      input.kind === "personal" &&
      [...this.collaborationWorkspaces.values()].some(
        (workspace) =>
          workspace.clientInstanceId === input.clientInstanceId &&
          workspace.personalUserId === input.personalUserId
      )
    ) {
      throw new AppError("CONFLICT", "User already has a Personal Workspace");
    }

    const now = new Date().toISOString();
    const workspace: CollaborationWorkspace = {
      id: createCollaborationWorkspaceId(),
      clientInstanceId: input.clientInstanceId,
      kind: input.kind,
      name: input.name,
      description: input.description ?? null,
      visibility: input.kind === "personal" ? "private" : (input.visibility ?? "discoverable"),
      emoji: input.emoji ?? null,
      accentColor: input.accentColor ?? null,
      personalUserId: input.kind === "personal" ? (input.personalUserId ?? null) : null,
      createdAt: now,
      updatedAt: now
    };
    this.collaborationWorkspaces.set(workspace.id, workspace);
    this.workspaceMemberships.set(workspaceMembershipKey(workspace.id, input.creatorUserId), {
      collaborationWorkspaceId: workspace.id,
      clientInstanceId: input.clientInstanceId,
      userId: input.creatorUserId,
      role: "owner",
      createdAt: now,
      updatedAt: now
    });
    return workspace;
  }

  async getWorkspace(
    clientInstanceId: ClientInstanceId,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<CollaborationWorkspace | undefined> {
    const workspace = this.collaborationWorkspaces.get(collaborationWorkspaceId);
    return workspace?.clientInstanceId === clientInstanceId ? workspace : undefined;
  }

  async listWorkspacesForUser(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserRecord["id"];
  }): Promise<CollaborationWorkspaceWithRole[]> {
    return [...this.workspaceMemberships.values()]
      .filter(
        (membership) =>
          membership.clientInstanceId === input.clientInstanceId &&
          membership.userId === input.userId
      )
      .map((membership) => {
        const workspace = this.collaborationWorkspaces.get(membership.collaborationWorkspaceId);
        if (!workspace) {
          throw new AppError("INTERNAL", "Workspace membership points to a missing workspace");
        }
        return { ...workspace, role: membership.role };
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listDiscoverableWorkspaces(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<CollaborationWorkspace[]> {
    return [...this.collaborationWorkspaces.values()]
      .filter(
        (workspace) =>
          workspace.clientInstanceId === input.clientInstanceId &&
          workspace.kind === "shared" &&
          workspace.visibility === "discoverable"
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async updateWorkspace(input: UpdateWorkspaceInput): Promise<CollaborationWorkspace> {
    const workspace = this.requireWorkspace(input.clientInstanceId, input.collaborationWorkspaceId);
    if (workspace.kind === "personal") {
      if (input.name !== undefined) {
        throw new AppError("VALIDATION_FAILED", "A Personal Workspace cannot be renamed");
      }
      if (input.visibility !== undefined && input.visibility !== "private") {
        throw new AppError("VALIDATION_FAILED", "A Personal Workspace must remain private");
      }
    }
    const updated: CollaborationWorkspace = {
      ...workspace,
      name: input.name ?? workspace.name,
      description: input.description === undefined ? workspace.description : input.description,
      visibility: input.visibility ?? workspace.visibility,
      emoji: input.emoji === undefined ? workspace.emoji : input.emoji,
      accentColor: input.accentColor === undefined ? workspace.accentColor : input.accentColor,
      updatedAt: new Date().toISOString()
    };
    this.collaborationWorkspaces.set(updated.id, updated);
    return updated;
  }

  async deleteWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<CollaborationWorkspace> {
    const workspace = this.requireWorkspace(input.clientInstanceId, input.collaborationWorkspaceId);
    if (workspace.kind === "personal") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace cannot be deleted");
    }
    if (
      [...this.conversations.values()].some(
        (conversation) =>
          conversation.collaborationWorkspaceId === workspace.id && conversation.status === "active"
      )
    ) {
      throw new AppError("CONFLICT", "Workspace still contains conversations");
    }
    for (const [id, conversation] of this.conversations) {
      if (conversation.collaborationWorkspaceId === workspace.id) {
        this.conversations.delete(id);
        this.messages.delete(id);
      }
    }
    this.deleteWorkspaceRecords(workspace.id);
    return workspace;
  }

  async ensurePersonalWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserRecord["id"];
  }): Promise<CollaborationWorkspace> {
    const existing = [...this.collaborationWorkspaces.values()].find(
      (workspace) =>
        workspace.clientInstanceId === input.clientInstanceId &&
        workspace.kind === "personal" &&
        workspace.personalUserId === input.userId
    );
    if (existing) {
      return existing;
    }
    return this.createWorkspace({
      clientInstanceId: input.clientInstanceId,
      kind: "personal",
      name: "Personal workspace",
      visibility: "private",
      personalUserId: input.userId,
      creatorUserId: input.userId
    });
  }

  async addMembership(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserRecord["id"];
    role: WorkspaceMembership["role"];
  }): Promise<WorkspaceMembership> {
    const workspace = this.requireWorkspace(input.clientInstanceId, input.collaborationWorkspaceId);
    if (workspace.kind === "personal") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace cannot gain members");
    }
    this.requireUser(input.clientInstanceId, input.userId);
    const key = workspaceMembershipKey(input.collaborationWorkspaceId, input.userId);
    if (this.workspaceMemberships.has(key)) {
      throw new AppError("CONFLICT", "Workspace membership already exists");
    }
    const now = new Date().toISOString();
    const membership: WorkspaceMembership = { ...input, createdAt: now, updatedAt: now };
    this.workspaceMemberships.set(key, membership);
    return membership;
  }

  async updateMembershipRole(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserRecord["id"];
    role: WorkspaceMembership["role"];
  }): Promise<WorkspaceMembership> {
    const workspace = this.requireWorkspace(input.clientInstanceId, input.collaborationWorkspaceId);
    if (workspace.kind === "personal") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace membership cannot change");
    }
    const membership = this.requireMembership(input);
    const updated = { ...membership, role: input.role, updatedAt: new Date().toISOString() };
    this.workspaceMemberships.set(
      workspaceMembershipKey(input.collaborationWorkspaceId, input.userId),
      updated
    );
    return updated;
  }

  async removeMembership(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserRecord["id"];
  }): Promise<WorkspaceMembership> {
    const workspace = this.requireWorkspace(input.clientInstanceId, input.collaborationWorkspaceId);
    if (workspace.kind === "personal") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace membership cannot be removed");
    }
    const membership = this.requireMembership(input);
    this.workspaceMemberships.delete(
      workspaceMembershipKey(input.collaborationWorkspaceId, input.userId)
    );
    return membership;
  }

  async listMemberships(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<WorkspaceMembership[]> {
    this.requireWorkspace(input.clientInstanceId, input.collaborationWorkspaceId);
    return [...this.workspaceMemberships.values()].filter(
      (membership) =>
        membership.clientInstanceId === input.clientInstanceId &&
        membership.collaborationWorkspaceId === input.collaborationWorkspaceId
    );
  }

  async searchMemberCandidates(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    query: string;
    limit: number;
  }): Promise<WorkspaceMemberCandidate[]> {
    this.requireWorkspace(input.clientInstanceId, input.collaborationWorkspaceId);
    const normalizedQuery = input.query.toLocaleLowerCase("en-US");
    return [...this.users.values()]
      .filter(
        (user) =>
          user.clientInstanceId === input.clientInstanceId &&
          user.status === "active" &&
          !this.workspaceMemberships.has(
            workspaceMembershipKey(input.collaborationWorkspaceId, user.id)
          )
      )
      .map((user) => {
        const verifiedIdentityEmails = this.getIdentitiesForUser(user)
          .filter((identity) => identity.emailVerified && identity.email)
          .map((identity) => identity.email!)
          .sort((left, right) => left.localeCompare(right));
        return {
          user,
          verifiedIdentityEmails,
          email: user.email ?? verifiedIdentityEmails[0]
        };
      })
      .filter(
        (candidate): candidate is typeof candidate & { email: string } =>
          Boolean(candidate.email) &&
          (candidate.user.displayLabel.toLocaleLowerCase("en-US").includes(normalizedQuery) ||
            candidate.user.email?.toLocaleLowerCase("en-US").includes(normalizedQuery) === true ||
            candidate.verifiedIdentityEmails.some((email) =>
              email.toLocaleLowerCase("en-US").includes(normalizedQuery)
            ))
      )
      .sort(
        (left, right) =>
          left.user.displayLabel
            .toLocaleLowerCase("en-US")
            .localeCompare(right.user.displayLabel.toLocaleLowerCase("en-US")) ||
          left.email
            .toLocaleLowerCase("en-US")
            .localeCompare(right.email.toLocaleLowerCase("en-US")) ||
          left.user.id.localeCompare(right.user.id)
      )
      .slice(0, input.limit)
      .map((candidate) => ({
        displayLabel: candidate.user.displayLabel,
        email: candidate.email,
        hasPendingAccessRequest: this.workspaceAccessRequests.has(
          workspaceMembershipKey(input.collaborationWorkspaceId, candidate.user.id)
        )
      }));
  }

  async getMembership(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserRecord["id"];
  }): Promise<WorkspaceMembership | undefined> {
    const membership = this.workspaceMemberships.get(
      workspaceMembershipKey(input.collaborationWorkspaceId, input.userId)
    );
    return membership?.clientInstanceId === input.clientInstanceId ? membership : undefined;
  }

  async createAccessRequest(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserRecord["id"];
  }): Promise<WorkspaceAccessRequest> {
    const workspace = this.requireWorkspace(input.clientInstanceId, input.collaborationWorkspaceId);
    if (workspace.kind !== "shared" || workspace.visibility !== "discoverable") {
      throw new AppError(
        "VALIDATION_FAILED",
        "Access requests require a Discoverable Shared Workspace"
      );
    }
    this.requireUser(input.clientInstanceId, input.userId);
    if (await this.getMembership(input)) {
      throw new AppError("CONFLICT", "User is already a workspace member");
    }
    const key = workspaceMembershipKey(input.collaborationWorkspaceId, input.userId);
    if (this.workspaceAccessRequests.has(key)) {
      throw new AppError("CONFLICT", "Workspace access request already exists");
    }
    const request: WorkspaceAccessRequest = {
      id: createWorkspaceAccessRequestId(),
      ...input,
      createdAt: new Date().toISOString()
    };
    this.workspaceAccessRequests.set(key, request);
    return request;
  }

  async deleteAccessRequest(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserRecord["id"];
  }): Promise<WorkspaceAccessRequest> {
    const request = await this.getAccessRequest(input);
    if (!request) {
      throw new AppError("NOT_FOUND", "Workspace access request is not available");
    }
    this.workspaceAccessRequests.delete(
      workspaceMembershipKey(input.collaborationWorkspaceId, input.userId)
    );
    return request;
  }

  async listAccessRequestsForWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<WorkspaceAccessRequest[]> {
    this.requireWorkspace(input.clientInstanceId, input.collaborationWorkspaceId);
    return [...this.workspaceAccessRequests.values()].filter(
      (request) =>
        request.clientInstanceId === input.clientInstanceId &&
        request.collaborationWorkspaceId === input.collaborationWorkspaceId
    );
  }

  async getAccessRequest(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserRecord["id"];
  }): Promise<WorkspaceAccessRequest | undefined> {
    const request = this.workspaceAccessRequests.get(
      workspaceMembershipKey(input.collaborationWorkspaceId, input.userId)
    );
    return request?.clientInstanceId === input.clientInstanceId ? request : undefined;
  }

  async deleteAccessRequestsForUser(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserRecord["id"];
  }): Promise<number> {
    const requests = [...this.workspaceAccessRequests.entries()].filter(
      ([, request]) =>
        request.clientInstanceId === input.clientInstanceId && request.userId === input.userId
    );
    for (const [key] of requests) this.workspaceAccessRequests.delete(key);
    return requests.length;
  }

  async removeMembershipsForUser(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserRecord["id"];
  }): Promise<number> {
    const memberships = [...this.workspaceMemberships.entries()].filter(([, membership]) => {
      const workspace = this.collaborationWorkspaces.get(membership.collaborationWorkspaceId);
      return (
        membership.clientInstanceId === input.clientInstanceId &&
        membership.userId === input.userId &&
        workspace?.kind === "shared"
      );
    });
    for (const [key] of memberships) this.workspaceMemberships.delete(key);
    return memberships.length;
  }

  async deletePersonalWorkspaceForUser(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserRecord["id"];
  }): Promise<CollaborationWorkspace> {
    const workspace = [...this.collaborationWorkspaces.values()].find(
      (candidate) =>
        candidate.clientInstanceId === input.clientInstanceId &&
        candidate.kind === "personal" &&
        candidate.personalUserId === input.userId
    );
    if (!workspace) {
      throw new AppError("NOT_FOUND", "Personal Workspace is not available");
    }
    if (
      [...this.conversations.values()].some(
        (conversation) =>
          conversation.collaborationWorkspaceId === workspace.id && conversation.status === "active"
      )
    ) {
      throw new AppError("CONFLICT", "Personal Workspace still has active conversations");
    }
    for (const [id, conversation] of this.conversations) {
      if (conversation.collaborationWorkspaceId === workspace.id) {
        this.conversations.delete(id);
        this.messages.delete(id);
      }
    }
    this.deleteWorkspaceRecords(workspace.id);
    return workspace;
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    this.requireWorkspace(input.clientInstanceId, input.collaborationWorkspaceId);
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: createPlatformId("conv"),
      clientInstanceId: input.clientInstanceId,
      collaborationWorkspaceId: input.collaborationWorkspaceId,
      createdByUserId: input.createdByUserId,
      createdByExternalUserId: input.createdByExternalUserId,
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

  async createConversationForTesting(
    input: Omit<CreateConversationInput, "collaborationWorkspaceId">
  ): Promise<Conversation> {
    let user = this.users.get(input.createdByUserId);
    if (!user) {
      const now = new Date().toISOString();
      user = {
        id: asUserId(input.createdByUserId),
        clientInstanceId: input.clientInstanceId,
        displayLabel: input.createdByExternalUserId,
        roles: ["user"],
        permissionRefs: [],
        permissions: [],
        status: "active",
        createdAt: now,
        updatedAt: now,
        identities: []
      };
      this.users.set(user.id, user);
    }
    if (user.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("CONFLICT", "Test user belongs to another client instance");
    }
    const workspace = await this.ensurePersonalWorkspace({
      clientInstanceId: input.clientInstanceId,
      userId: user.id
    });
    return this.createConversation({ ...input, collaborationWorkspaceId: workspace.id });
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

  async listConversationsForWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .filter(
        (conversation) =>
          conversation.clientInstanceId === input.clientInstanceId &&
          conversation.collaborationWorkspaceId === input.collaborationWorkspaceId &&
          conversation.status === "active"
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async moveConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fromCollaborationWorkspaceId: CollaborationWorkspaceId;
    toCollaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<Conversation> {
    this.requireWorkspace(input.clientInstanceId, input.toCollaborationWorkspaceId);
    const conversation = await this.getConversation(input.clientInstanceId, input.conversationId);
    if (
      !conversation ||
      conversation.status !== "active" ||
      conversation.collaborationWorkspaceId !== input.fromCollaborationWorkspaceId
    ) {
      throw new AppError("CONFLICT", "Conversation workspace changed during the move");
    }
    const moved = {
      ...conversation,
      collaborationWorkspaceId: input.toCollaborationWorkspaceId
    };
    this.conversations.set(input.conversationId, moved);
    return moved;
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

  async appendAssistantMessage(input: AppendAssistantMessageInput): Promise<ChatMessage> {
    const conversation = await this.getConversation(input.clientInstanceId, input.conversationId);
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }

    const message: ChatMessage = {
      id: input.id ?? createPlatformId("msg"),
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      role: "assistant",
      text: input.text,
      createdAt: new Date().toISOString(),
      metadata: input.metadata
    };
    const checkpoint = input.providerContinuation
      ? {
          clientInstanceId: input.clientInstanceId,
          conversationId: input.conversationId,
          providerId: input.providerContinuation.providerId,
          state: input.providerContinuation.state,
          sourceMessageId: message.id,
          updatedAt: message.createdAt
        }
      : undefined;
    const messages = this.messages.get(input.conversationId) ?? [];
    messages.push(message);
    this.messages.set(input.conversationId, messages);
    if (checkpoint) {
      this.modelProviderContinuations.set(
        modelProviderContinuationKey(input.conversationId, checkpoint.providerId),
        checkpoint
      );
    }
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

  async getModelProviderContinuation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    providerId: string;
  }): Promise<ModelProviderContinuationCheckpoint | undefined> {
    const checkpoint = this.modelProviderContinuations.get(
      modelProviderContinuationKey(input.conversationId, input.providerId)
    );
    return checkpoint?.clientInstanceId === input.clientInstanceId ? checkpoint : undefined;
  }

  async claimRunStartCommand(
    input: ClaimRunStartCommandInput
  ): Promise<ClaimRunStartCommandResult> {
    const key = runStartCommandKey(input);
    const existing = this.runStartCommands.get(key);
    if (existing) {
      if (
        existing.status === "pending" &&
        input.reclaimPendingBefore &&
        existing.updatedAt < input.reclaimPendingBefore
      ) {
        const now = input.createdAt ?? new Date().toISOString();
        const command: RunStartCommand = {
          ...existing,
          status: "pending",
          conversationId: undefined,
          userMessageId: undefined,
          runId: undefined,
          updatedAt: now
        };
        this.runStartCommands.set(key, command);
        return {
          status: "claimed",
          command
        };
      }
      return {
        status: "existing",
        command: existing
      };
    }

    const now = input.createdAt ?? new Date().toISOString();
    const command: RunStartCommand = {
      clientInstanceId: input.clientInstanceId,
      ownerUserId: input.ownerUserId,
      idempotencyKey: input.idempotencyKey,
      commandKind: input.commandKind,
      status: "pending",
      createdAt: now,
      updatedAt: now
    };
    this.runStartCommands.set(key, command);
    return {
      status: "claimed",
      command
    };
  }

  async completeRunStartCommand(input: CompleteRunStartCommandInput): Promise<RunStartCommand> {
    const key = runStartCommandKey(input);
    const existing = this.runStartCommands.get(key);
    if (!existing) {
      throw new AppError("NOT_FOUND", "Run start command is not available");
    }
    if (input.claimedAt && existing.updatedAt !== input.claimedAt) {
      throw new AppError("NOT_FOUND", "Run start command is not available");
    }
    const completed: RunStartCommand = {
      ...existing,
      status: "completed",
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
      runId: input.runId,
      updatedAt: input.updatedAt
    };
    this.runStartCommands.set(key, completed);
    return completed;
  }

  async releaseRunStartCommand(input: ReleaseRunStartCommandInput): Promise<void> {
    const key = runStartCommandKey(input);
    const existing = this.runStartCommands.get(key);
    if (!existing || existing.status !== "pending") {
      return;
    }
    if (input.claimedAt && existing.updatedAt !== input.claimedAt) {
      return;
    }
    this.runStartCommands.delete(key);
  }

  async prepareConversationRunStart(
    input: PrepareConversationRunStartInput
  ): Promise<PreparedConversationRunStart> {
    const conversation = await this.getConversation(input.clientInstanceId, input.conversationId);
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    const activeRun = await this.getActiveConversationAgentRun({
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId
    });
    if (activeRun) {
      throw new AppError("CONFLICT", "Conversation already has an active agent run");
    }
    if (input.runStartCommand) {
      const command = this.runStartCommands.get(
        runStartCommandKey({
          clientInstanceId: input.clientInstanceId,
          ownerUserId: input.ownerUserId,
          commandKind: input.runStartCommand.commandKind,
          idempotencyKey: input.runStartCommand.idempotencyKey
        })
      );
      if (!command || command.status !== "pending") {
        throw new AppError("NOT_FOUND", "Run start command is not available");
      }
      if (
        input.runStartCommand.claimedAt &&
        command.updatedAt !== input.runStartCommand.claimedAt
      ) {
        throw new AppError("NOT_FOUND", "Run start command is not available");
      }
    }

    const userMessage = await this.appendMessage({
      id: input.userMessage.id,
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      role: "user",
      text: input.userMessage.text,
      metadata: input.userMessage.metadata
    });
    if (input.claimReadyDraftAttachments) {
      await this.claimReadyDraftAttachmentsForMessage({
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        messageId: userMessage.id,
        claimedAt: userMessage.createdAt
      });
    }
    const run = await this.createAgentRun({ ...input.run, status: input.run.status ?? "queued" });
    if (input.runStartCommand) {
      await this.completeRunStartCommand({
        clientInstanceId: input.clientInstanceId,
        ownerUserId: input.ownerUserId,
        idempotencyKey: input.runStartCommand.idempotencyKey,
        commandKind: input.runStartCommand.commandKind,
        claimedAt: input.runStartCommand.claimedAt,
        conversationId: input.conversationId,
        userMessageId: userMessage.id,
        runId: run.id,
        updatedAt: run.startedAt
      });
    }
    return { userMessage, run };
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
    const existing = this.agentRuns.get(input.id);
    if (existing) {
      throw new AppError("CONFLICT", "Agent run already exists");
    }
    const activeRun = [...this.agentRuns.values()].find(
      (run) =>
        run.clientInstanceId === input.clientInstanceId &&
        run.conversationId === input.conversationId &&
        isActiveAgentRunStatus(run.status)
    );
    if (activeRun) {
      throw new AppError("CONFLICT", "Conversation already has an active agent run");
    }
    if (input.idempotencyKey) {
      const idempotentRun = [...this.agentRuns.values()].find(
        (run) =>
          run.clientInstanceId === input.clientInstanceId &&
          run.conversationId === input.conversationId &&
          run.idempotencyKey === input.idempotencyKey
      );
      if (idempotentRun) {
        throw new AppError("CONFLICT", "Agent run idempotency key already exists");
      }
    }

    const now = input.startedAt ?? new Date().toISOString();
    const run: AgentRun = {
      id: input.id,
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      inputMessageId: input.inputMessageId,
      agentName: input.agentName,
      modelBindingId: input.modelBindingId,
      locale: input.locale,
      authorization: input.authorization,
      status: input.status ?? "running",
      idempotencyKey: input.idempotencyKey,
      startedAt: now,
      updatedAt: now,
      lastSequence: 0,
      correlationId: input.correlationId
    };
    this.agentRuns.set(run.id, run);
    this.runObservations.set(run.id, []);
    return run;
  }

  async getAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
  }): Promise<AgentRun | undefined> {
    const run = this.agentRuns.get(input.runId);
    return run?.clientInstanceId === input.clientInstanceId ? run : undefined;
  }

  async getConversationAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    runId: AgentRunId;
  }): Promise<AgentRun | undefined> {
    const run = await this.getAgentRun(input);
    return run?.conversationId === input.conversationId ? run : undefined;
  }

  async getActiveConversationAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<AgentRun | undefined> {
    return [...this.agentRuns.values()].find(
      (run) =>
        run.clientInstanceId === input.clientInstanceId &&
        run.conversationId === input.conversationId &&
        isActiveAgentRunStatus(run.status)
    );
  }

  async getLatestConversationAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<AgentRun | undefined> {
    return [...this.agentRuns.values()]
      .filter(
        (run) =>
          run.clientInstanceId === input.clientInstanceId &&
          run.conversationId === input.conversationId
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  }

  async updateAgentRunStatus(input: UpdateAgentRunStatusInput): Promise<AgentRun> {
    const run = await this.getAgentRun({
      clientInstanceId: input.clientInstanceId,
      runId: input.runId
    });
    if (!run) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }
    const updated: AgentRun = {
      ...run,
      status: input.status,
      updatedAt: input.updatedAt,
      lastSequence: input.lastSequence ?? run.lastSequence,
      completedAt: input.completedAt ?? run.completedAt,
      cancelledAt: input.cancelledAt ?? run.cancelledAt,
      failedAt: input.failedAt ?? run.failedAt,
      error: input.error ?? run.error
    };
    this.agentRuns.set(run.id, updated);
    return updated;
  }

  async listStaleActiveAgentRuns(input: {
    clientInstanceId: ClientInstanceId;
    staleUpdatedBefore: string;
    limit: number;
  }): Promise<AgentRun[]> {
    return [...this.agentRuns.values()]
      .filter(
        (run) =>
          run.clientInstanceId === input.clientInstanceId &&
          isActiveAgentRunStatus(run.status) &&
          run.updatedAt < input.staleUpdatedBefore
      )
      .sort((left, right) =>
        `${left.updatedAt}:${left.id}`.localeCompare(`${right.updatedAt}:${right.id}`)
      )
      .slice(0, input.limit);
  }

  async recoverStaleAgentRun(
    input: RecoverStaleAgentRunInput
  ): Promise<RecoverStaleAgentRunResult> {
    const run = await this.getAgentRun({
      clientInstanceId: input.clientInstanceId,
      runId: input.runId
    });
    if (!run) {
      return { status: "not_recovered" };
    }
    if (!isActiveAgentRunStatus(run.status) || run.updatedAt >= input.staleUpdatedBefore) {
      return { status: "not_recovered", run };
    }

    const terminalObservation = [...(this.runObservations.get(input.runId) ?? [])]
      .reverse()
      .find((observation) => isTerminalRunObservation(observation));
    if (terminalObservation) {
      const updated = terminalRunFromObservation(run, terminalObservation);
      this.agentRuns.set(run.id, updated);
      return {
        status: "recovered",
        run: updated
      };
    }

    const sequence = run.lastSequence + 1;
    const event = {
      type: "run_failed" as const,
      runId: run.id,
      sequence,
      createdAt: input.recoveredAt,
      error: input.error
    };
    const observation: RunObservation = {
      clientInstanceId: run.clientInstanceId,
      runId: run.id,
      conversationId: run.conversationId,
      ownerUserId: run.ownerUserId,
      sequence,
      type: "run_failed",
      payload: event,
      createdAt: input.recoveredAt
    };
    this.runObservations.set(run.id, [...(this.runObservations.get(run.id) ?? []), observation]);
    const updated: AgentRun = {
      ...run,
      status: "failed",
      updatedAt: input.recoveredAt,
      failedAt: input.recoveredAt,
      lastSequence: sequence,
      error: input.error
    };
    this.agentRuns.set(run.id, updated);
    return {
      status: "recovered",
      run: updated,
      observation
    };
  }

  async claimNextAgentRun(input: ClaimAgentRunInput): Promise<AgentRun | undefined> {
    const run = [...this.agentRuns.values()]
      .filter(
        (candidate) =>
          candidate.clientInstanceId === input.clientInstanceId && candidate.status === "queued"
      )
      .sort((left, right) =>
        `${left.startedAt}:${left.id}`.localeCompare(`${right.startedAt}:${right.id}`)
      )[0];
    if (!run) return undefined;
    const claimed: AgentRun = {
      ...run,
      status: "running",
      leaseOwner: input.workerId,
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      heartbeatAt: input.now,
      updatedAt: input.now
    };
    this.agentRuns.set(run.id, claimed);
    return claimed;
  }

  async heartbeatAgentRun(input: HeartbeatAgentRunInput): Promise<AgentRun> {
    const run = await this.requireActiveAgentRunLease(input, input.heartbeatAt);
    const updated: AgentRun = {
      ...run,
      heartbeatAt: input.heartbeatAt,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.heartbeatAt
    };
    this.agentRuns.set(run.id, updated);
    return updated;
  }

  async requestAgentRunCancellation(input: RequestAgentRunCancellationInput): Promise<AgentRun> {
    const run = await this.getAgentRun(input);
    if (!run) throw new AppError("NOT_FOUND", "Agent run is not available");
    if (!isActiveAgentRunStatus(run.status)) return run;
    if (run.status === "queued") {
      const sequence = run.lastSequence + 1;
      const event = {
        type: "run_cancelled" as const,
        runId: run.id,
        sequence,
        createdAt: input.requestedAt,
        ...(input.reason ? { reason: input.reason } : {})
      };
      const observation: RunObservation = {
        clientInstanceId: run.clientInstanceId,
        runId: run.id,
        conversationId: run.conversationId,
        ownerUserId: run.ownerUserId,
        sequence,
        type: event.type,
        payload: event,
        createdAt: input.requestedAt
      };
      this.runObservations.set(run.id, [...(this.runObservations.get(run.id) ?? []), observation]);
      const cancelled: AgentRun = {
        ...run,
        status: "cancelled",
        cancellationRequestedAt: input.requestedAt,
        cancellationReason: input.reason,
        cancelledAt: input.requestedAt,
        updatedAt: input.requestedAt,
        lastSequence: sequence
      };
      this.agentRuns.set(run.id, cancelled);
      return cancelled;
    }
    const cancelling: AgentRun = {
      ...run,
      status: "cancelling",
      cancellationRequestedAt: input.requestedAt,
      cancellationReason: input.reason,
      updatedAt: input.requestedAt
    };
    this.agentRuns.set(run.id, cancelling);
    return cancelling;
  }

  async appendClaimedRunObservation(
    input: AppendClaimedRunObservationInput
  ): Promise<RunObservation> {
    const run = await this.requireActiveAgentRunLease(input, input.event.createdAt);
    if (input.event.runId !== input.runId || input.event.sequence !== run.lastSequence + 1) {
      throw new AppError("CONFLICT", "Agent run lease or observation sequence is stale");
    }
    if (run.status === "cancelling" && input.event.type !== "run_cancelled") {
      throw new AppError("CONFLICT", "Only cancellation may terminalize a cancelling agent run");
    }
    const observation: RunObservation = {
      clientInstanceId: run.clientInstanceId,
      runId: run.id,
      conversationId: run.conversationId,
      ownerUserId: run.ownerUserId,
      sequence: input.event.sequence,
      type: input.event.type,
      payload: input.event,
      createdAt: input.event.createdAt
    };
    this.runObservations.set(run.id, [...(this.runObservations.get(run.id) ?? []), observation]);
    let updated: AgentRun = {
      ...run,
      lastSequence: input.event.sequence,
      updatedAt: input.event.createdAt
    };
    if (input.event.type === "tool_permission_requested") {
      updated = { ...updated, status: "waiting_for_permission" };
    } else if (isTerminalRunObservation(observation)) {
      updated = {
        ...terminalRunFromObservation(updated, observation),
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        heartbeatAt: undefined
      };
    }
    this.agentRuns.set(run.id, updated);
    return observation;
  }

  async assertClaimedAgentRun(input: AssertClaimedAgentRunInput): Promise<AgentRun> {
    return this.requireActiveAgentRunLease(input, new Date().toISOString());
  }

  async appendClaimedAgentRunMessage(
    input: AppendClaimedAgentRunMessageInput
  ): Promise<ChatMessage> {
    const run = await this.assertClaimedAgentRun(input);
    if (input.message.conversationId !== run.conversationId) {
      throw new AppError("CONFLICT", "Agent run message belongs to another conversation");
    }
    return input.message.role === "assistant"
      ? this.appendAssistantMessage(input.message)
      : this.appendMessage(input.message);
  }

  async recoverExpiredAgentRuns(input: RecoverExpiredAgentRunsInput): Promise<AgentRun[]> {
    const stale = [...this.agentRuns.values()]
      .filter(
        (run) =>
          run.clientInstanceId === input.clientInstanceId &&
          (run.status === "running" ||
            run.status === "waiting_for_permission" ||
            run.status === "cancelling") &&
          run.leaseExpiresAt !== undefined &&
          run.leaseExpiresAt < input.leaseExpiredBefore
      )
      .sort((left, right) =>
        `${left.leaseExpiresAt}:${left.id}`.localeCompare(`${right.leaseExpiresAt}:${right.id}`)
      )
      .slice(0, input.limit);
    const recovered: AgentRun[] = [];
    for (const run of stale) {
      const sequence = run.lastSequence + 1;
      const event = {
        type: "run_failed" as const,
        runId: run.id,
        sequence,
        createdAt: input.recoveredAt,
        error: input.error
      };
      const observation: RunObservation = {
        clientInstanceId: run.clientInstanceId,
        runId: run.id,
        conversationId: run.conversationId,
        ownerUserId: run.ownerUserId,
        sequence,
        type: event.type,
        payload: event,
        createdAt: input.recoveredAt
      };
      this.runObservations.set(run.id, [...(this.runObservations.get(run.id) ?? []), observation]);
      const failed: AgentRun = {
        ...run,
        status: "failed",
        failedAt: input.recoveredAt,
        updatedAt: input.recoveredAt,
        lastSequence: sequence,
        error: input.error,
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        heartbeatAt: undefined
      };
      this.agentRuns.set(run.id, failed);
      recovered.push(failed);
    }
    return recovered;
  }

  private async requireActiveAgentRunLease(
    input: {
      clientInstanceId: ClientInstanceId;
      runId: AgentRunId;
      leaseToken: string;
    },
    validAt: string
  ): Promise<AgentRun> {
    const run = await this.getAgentRun(input);
    if (
      !run ||
      run.leaseToken !== input.leaseToken ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= validAt ||
      (run.status !== "running" &&
        run.status !== "waiting_for_permission" &&
        run.status !== "cancelling")
    ) {
      throw new AppError("CONFLICT", "Agent run lease is no longer active");
    }
    return run;
  }

  async appendRunObservation(input: AppendRunObservationInput): Promise<RunObservation> {
    const run = await this.getConversationAgentRun(input);
    if (!run) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }
    const observations = this.runObservations.get(input.runId) ?? [];
    if (observations.some((observation) => observation.sequence === input.event.sequence)) {
      throw new AppError("CONFLICT", "Agent run observation sequence already exists");
    }
    const observation: RunObservation = {
      clientInstanceId: input.clientInstanceId,
      runId: input.runId,
      conversationId: input.conversationId,
      ownerUserId: run.ownerUserId,
      sequence: input.event.sequence,
      type: input.event.type,
      payload: input.event,
      createdAt: input.event.createdAt
    };
    observations.push(observation);
    observations.sort((left, right) => left.sequence - right.sequence);
    this.runObservations.set(input.runId, observations);
    this.agentRuns.set(input.runId, {
      ...run,
      lastSequence: Math.max(run.lastSequence, observation.sequence),
      updatedAt: observation.createdAt
    });
    return observation;
  }

  async listRunObservations(input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
    afterSequence?: number;
    limit?: number;
  }): Promise<RunObservation[]> {
    const run = await this.getAgentRun(input);
    if (!run) {
      return [];
    }
    const afterSequence = input.afterSequence ?? 0;
    const observations = (this.runObservations.get(input.runId) ?? []).filter(
      (observation) =>
        observation.clientInstanceId === input.clientInstanceId &&
        observation.sequence > afterSequence
    );
    return input.limit === undefined ? observations : observations.slice(0, input.limit);
  }

  async ensureExecutionWorkspace(
    input: Parameters<ExecutionWorkspaceMetadataStore["ensureExecutionWorkspace"]>[0]
  ) {
    return this.executionWorkspaceStore.ensureExecutionWorkspace(input);
  }

  async getExecutionWorkspace(
    input: Parameters<ExecutionWorkspaceMetadataStore["getExecutionWorkspace"]>[0]
  ) {
    return this.executionWorkspaceStore.getExecutionWorkspace(input);
  }

  async getExecutionWorkspaceForConversation(
    input: Parameters<ExecutionWorkspaceMetadataStore["getExecutionWorkspaceForConversation"]>[0]
  ) {
    return this.executionWorkspaceStore.getExecutionWorkspaceForConversation(input);
  }

  async upsertWorkspaceFile(
    input: Parameters<ExecutionWorkspaceFileStore["upsertWorkspaceFile"]>[0]
  ) {
    return this.executionWorkspaceStore.upsertWorkspaceFile(input);
  }

  async deleteWorkspaceFile(
    input: Parameters<ExecutionWorkspaceFileStore["deleteWorkspaceFile"]>[0]
  ) {
    return this.executionWorkspaceStore.deleteWorkspaceFile(input);
  }

  async listWorkspaceFiles(
    input: Parameters<ExecutionWorkspaceFileStore["listWorkspaceFiles"]>[0]
  ) {
    return this.executionWorkspaceStore.listWorkspaceFiles(input);
  }

  async countActiveWorkspaceCommands(
    input: Parameters<WorkspaceCommandStore["countActiveWorkspaceCommands"]>[0]
  ) {
    return this.executionWorkspaceStore.countActiveWorkspaceCommands(input);
  }

  async enqueueWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["enqueueWorkspaceCommand"]>[0]
  ) {
    return this.executionWorkspaceStore.enqueueWorkspaceCommand(input);
  }

  async getWorkspaceCommand(input: Parameters<WorkspaceCommandStore["getWorkspaceCommand"]>[0]) {
    return this.executionWorkspaceStore.getWorkspaceCommand(input);
  }

  async claimNextWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["claimNextWorkspaceCommand"]>[0]
  ) {
    return this.executionWorkspaceStore.claimNextWorkspaceCommand(input);
  }

  async completeWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["completeWorkspaceCommand"]>[0]
  ) {
    return this.executionWorkspaceStore.completeWorkspaceCommand(input);
  }

  async failWorkspaceCommand(input: Parameters<WorkspaceCommandStore["failWorkspaceCommand"]>[0]) {
    return this.executionWorkspaceStore.failWorkspaceCommand(input);
  }

  async requestWorkspaceCommandCancellation(
    input: Parameters<WorkspaceCommandStore["requestWorkspaceCommandCancellation"]>[0]
  ) {
    return this.executionWorkspaceStore.requestWorkspaceCommandCancellation(input);
  }

  async cancelClaimedWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["cancelClaimedWorkspaceCommand"]>[0]
  ) {
    return this.executionWorkspaceStore.cancelClaimedWorkspaceCommand(input);
  }

  async heartbeatWorkspaceCommand(
    input: Parameters<WorkspaceCommandStore["heartbeatWorkspaceCommand"]>[0]
  ) {
    return this.executionWorkspaceStore.heartbeatWorkspaceCommand(input);
  }

  async recoverStaleWorkspaceCommands(
    input: Parameters<WorkspaceCommandStore["recoverStaleWorkspaceCommands"]>[0]
  ) {
    return this.executionWorkspaceStore.recoverStaleWorkspaceCommands(input);
  }

  async listExecutionWorkspaceCleanupTargets(
    input: Parameters<ExecutionWorkspaceCleanupStore["listExecutionWorkspaceCleanupTargets"]>[0]
  ) {
    return this.executionWorkspaceStore.listExecutionWorkspaceCleanupTargets(input);
  }

  async listExecutionWorkspaceObjectsForDeletion(
    input: Parameters<ExecutionWorkspaceCleanupStore["listExecutionWorkspaceObjectsForDeletion"]>[0]
  ) {
    return this.executionWorkspaceStore.listExecutionWorkspaceObjectsForDeletion(input);
  }

  async markExecutionWorkspaceDeleted(
    input: Parameters<ExecutionWorkspaceCleanupStore["markExecutionWorkspaceDeleted"]>[0]
  ) {
    return this.executionWorkspaceStore.markExecutionWorkspaceDeleted(input);
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

  async ensureManagedArtifact(input: Parameters<PlatformFileStore["ensureManagedArtifact"]>[0]) {
    return this.fileStore.ensureManagedArtifact(input);
  }

  async getManagedArtifact(input: Parameters<PlatformFileStore["getManagedArtifact"]>[0]) {
    return this.fileStore.getManagedArtifact(input);
  }

  async listManagedArtifactsForFile(
    input: Parameters<PlatformFileStore["listManagedArtifactsForFile"]>[0]
  ) {
    return this.fileStore.listManagedArtifactsForFile(input);
  }

  async listConversationManagedArtifacts(
    input: Parameters<PlatformFileStore["listConversationManagedArtifacts"]>[0]
  ) {
    return this.fileStore.listConversationManagedArtifacts(input);
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

  async renewClaimedArtifactPreviewJobLease(
    input: Parameters<PlatformFileStore["renewClaimedArtifactPreviewJobLease"]>[0]
  ) {
    return this.fileStore.renewClaimedArtifactPreviewJobLease(input);
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

  async listSentConversationAttachments(
    input: Parameters<PlatformFileStore["listSentConversationAttachments"]>[0]
  ) {
    return this.fileStore.listSentConversationAttachments(input);
  }

  async findConversationAttachmentByChecksum(
    input: Parameters<PlatformFileStore["findConversationAttachmentByChecksum"]>[0]
  ) {
    return this.fileStore.findConversationAttachmentByChecksum(input);
  }

  async updateConversationAttachment(
    input: Parameters<PlatformFileStore["updateConversationAttachment"]>[0]
  ) {
    return this.fileStore.updateConversationAttachment(input);
  }

  async reactivateDraftAttachment(
    input: Parameters<PlatformFileStore["reactivateDraftAttachment"]>[0]
  ) {
    return this.fileStore.reactivateDraftAttachment(input);
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
    for (const [key, checkpoint] of this.modelProviderContinuations) {
      if (checkpoint.conversationId === input.conversationId) {
        this.modelProviderContinuations.delete(key);
      }
    }
    for (const resource of this.structuredDataResources.values()) {
      if (
        resource.clientInstanceId === input.clientInstanceId &&
        resource.conversationId === input.conversationId
      ) {
        this.structuredDataResources.delete(resource.id);
      }
    }
    for (const run of this.agentRuns.values()) {
      if (
        run.clientInstanceId === input.clientInstanceId &&
        run.conversationId === input.conversationId
      ) {
        this.agentRuns.delete(run.id);
        this.runObservations.delete(run.id);
      }
    }
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

  async appendModelUsageEvent(input: ModelUsageEventRecordInput): Promise<ModelUsageEvent> {
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
      await this.ensurePersonalWorkspace({
        clientInstanceId: input.clientInstanceId,
        userId: user.id
      });
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
    await this.ensurePersonalWorkspace({
      clientInstanceId: input.clientInstanceId,
      userId: updatedUser.id
    });
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
      permissions: input.permissions ?? [],
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
      identities: []
    };
    this.users.set(user.id, user);
    await this.ensurePersonalWorkspace({
      clientInstanceId: input.clientInstanceId,
      userId: user.id
    });
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
      permissions: input.permissions ?? user.permissions,
      status: input.status ?? user.status,
      updatedAt: new Date().toISOString()
    };
    this.users.set(updated.id, updated);
    return this.attachIdentities(updated);
  }

  async deleteUser(input: DeleteUserInput): Promise<UserRecord> {
    const user = this.users.get(input.userId);
    if (!user || user.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("NOT_FOUND", "User is not available");
    }
    if (
      [...this.workspaceMemberships.values()].some(
        (membership) =>
          membership.clientInstanceId === input.clientInstanceId &&
          membership.userId === input.userId
      ) ||
      [...this.collaborationWorkspaces.values()].some(
        (workspace) =>
          workspace.clientInstanceId === input.clientInstanceId &&
          workspace.personalUserId === input.userId
      )
    ) {
      throw new AppError("CONFLICT", "User workspace lifecycle cleanup is required");
    }

    const deleted = this.attachIdentities(user);
    for (const identity of deleted.identities) {
      this.identities.delete(createIdentityKey(identity));
    }
    this.users.delete(user.id);
    return deleted;
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
      permissions: input.permissions,
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

  private requireUser(clientInstanceId: ClientInstanceId, userId: UserRecord["id"]): UserRecord {
    const user = this.users.get(userId);
    if (!user || user.clientInstanceId !== clientInstanceId) {
      throw new AppError("NOT_FOUND", "User is not available");
    }
    return user;
  }

  private requireWorkspace(
    clientInstanceId: ClientInstanceId,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): CollaborationWorkspace {
    const workspace = this.collaborationWorkspaces.get(collaborationWorkspaceId);
    if (!workspace || workspace.clientInstanceId !== clientInstanceId) {
      throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    }
    return workspace;
  }

  private requireMembership(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserRecord["id"];
  }): WorkspaceMembership {
    const membership = this.workspaceMemberships.get(
      workspaceMembershipKey(input.collaborationWorkspaceId, input.userId)
    );
    if (!membership || membership.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("NOT_FOUND", "Workspace Membership is not available");
    }
    return membership;
  }

  private deleteWorkspaceRecords(collaborationWorkspaceId: CollaborationWorkspaceId): void {
    for (const [key, membership] of this.workspaceMemberships) {
      if (membership.collaborationWorkspaceId === collaborationWorkspaceId) {
        this.workspaceMemberships.delete(key);
      }
    }
    for (const [key, request] of this.workspaceAccessRequests) {
      if (request.collaborationWorkspaceId === collaborationWorkspaceId) {
        this.workspaceAccessRequests.delete(key);
      }
    }
    this.collaborationWorkspaces.delete(collaborationWorkspaceId);
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

function workspaceMembershipKey(
  collaborationWorkspaceId: CollaborationWorkspaceId,
  userId: UserRecord["id"]
): string {
  return `${collaborationWorkspaceId}:${userId}`;
}

function modelProviderContinuationKey(conversationId: ConversationId, providerId: string): string {
  return `${conversationId}:${providerId}`;
}

function runStartCommandKey(input: {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  commandKind: string;
  idempotencyKey: string;
}): string {
  return [input.clientInstanceId, input.ownerUserId, input.commandKind, input.idempotencyKey].join(
    "\u0000"
  );
}

function isActiveAgentRunStatus(status: AgentRun["status"]): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_permission" ||
    status === "cancelling"
  );
}

function isTerminalRunObservation(observation: RunObservation): boolean {
  return (
    observation.payload.type === "run_completed" ||
    observation.payload.type === "run_cancelled" ||
    observation.payload.type === "run_failed"
  );
}

function terminalRunFromObservation(run: AgentRun, observation: RunObservation): AgentRun {
  const event = observation.payload;
  if (event.type === "run_completed") {
    return {
      ...run,
      status: "completed",
      updatedAt: event.createdAt,
      completedAt: event.createdAt,
      lastSequence: Math.max(run.lastSequence, event.sequence)
    };
  }
  if (event.type === "run_cancelled") {
    return {
      ...run,
      status: "cancelled",
      updatedAt: event.createdAt,
      cancelledAt: event.createdAt,
      lastSequence: Math.max(run.lastSequence, event.sequence)
    };
  }
  if (event.type !== "run_failed") {
    throw new AppError("INTERNAL", "Expected terminal run observation");
  }
  return {
    ...run,
    status: "failed",
    updatedAt: event.createdAt,
    failedAt: event.createdAt,
    lastSequence: Math.max(run.lastSequence, event.sequence),
    error: event.error
  };
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
    `${left.authSource}:${left.externalUserId}`.localeCompare(
      `${right.authSource}:${right.externalUserId}`
    )
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
      cachedInputTokens: summary.cachedInputTokens + (event.cachedInputTokens ?? 0),
      outputTokens: summary.outputTokens + event.outputTokens,
      totalTokens: summary.totalTokens + event.totalTokens,
      webSearchCallCount: summary.webSearchCallCount + event.webSearchCallCount
    }),
    {
      start,
      end,
      modelCallCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      webSearchCallCount: 0
    }
  );
}

export function createStaticConfigAssetSource(input: {
  agents?: AgentConfig[];
  skills?: SkillConfig[];
  defaultAgentName?: string;
  version?: number;
}): ConfigAssetSource {
  return {
    async getSnapshot(): Promise<RuntimeAssetSnapshot> {
      return {
        version: input.version ?? 1,
        defaultAgentName: input.defaultAgentName,
        agents: input.agents ?? [],
        skills: input.skills ?? []
      };
    }
  };
}
