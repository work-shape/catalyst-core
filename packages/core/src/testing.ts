import {
  AppError,
  type AgentRun,
  type AgentRunId,
  type AgentRunStore,
  type AppendRunObservationInput,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventStore,
  type ChatMessage,
  type ClaimRunStartCommandInput,
  type ClaimRunStartCommandResult,
  type ClientInstanceId,
  type CompleteRunStartCommandInput,
  type Conversation,
  type ConversationId,
  type ConversationRetentionStore,
  type ConversationStore,
  type CreateAgentRunInput,
  type CreateConversationInput,
  type CreateMessageInput,
  type ExecutionWorkspaceCleanupStore,
  type ExecutionWorkspaceFileStore,
  type ExecutionWorkspaceMetadataStore,
  type PlatformFileStore,
  type PrepareConversationRunStartInput,
  type PreparedConversationRunStart,
  type ReleaseRunStartCommandInput,
  type RecoverStaleAgentRunInput,
  type RecoverStaleAgentRunResult,
  type RunObservation,
  type RunObservationStore,
  type RunStartCommand,
  type ModelUsageEvent,
  type ModelUsageEventInput,
  type ModelUsageEventStore,
  type ModelUsageWindowSummary,
  type CreateUserInput,
  type DeleteUserIdentityInput,
  type ResolveUserIdentityInput,
  type UpdateUserInput,
  type UpdateAgentRunStatusInput,
  type UpsertUserIdentityInput,
  type UserIdentity,
  type UserRecord,
  type UserStore,
  type WorkspaceCommandStore,
  authenticatedUserFromRecord,
  createUserId,
  createPlatformId
} from "./index";
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
    PlatformFileStore,
    AgentRunStore,
    RunObservationStore,
    ExecutionWorkspaceMetadataStore,
    ExecutionWorkspaceFileStore,
    WorkspaceCommandStore,
    ExecutionWorkspaceCleanupStore,
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
  private readonly agentRuns = new Map<string, AgentRun>();
  private readonly runStartCommands = new Map<string, RunStartCommand>();
  private readonly runObservations = new Map<string, RunObservation[]>();
  private readonly executionWorkspaceStore: InMemoryExecutionWorkspaceStore =
    createInMemoryExecutionWorkspaceStore({
      requireOwnedActiveConversation: (clientInstanceId, conversationId, ownerUserId) =>
        this.requireOwnedActiveConversation(clientInstanceId, conversationId, ownerUserId),
      isConversationActive: async (clientInstanceId, conversationId) => {
        const conversation = await this.getConversation(clientInstanceId, conversationId);
        return conversation?.status === "active";
      }
    });
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
    if (!conversation || conversation.status !== "active" || conversation.ownerUserId !== input.ownerUserId) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    const activeRun = await this.getActiveConversationAgentRun({
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId
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
      if (input.runStartCommand.claimedAt && command.updatedAt !== input.runStartCommand.claimedAt) {
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
    const run = await this.createAgentRun(input.run);
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
      status: "running",
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
    ownerUserId: string;
  }): Promise<AgentRun | undefined> {
    return [...this.agentRuns.values()].find(
      (run) =>
        run.clientInstanceId === input.clientInstanceId &&
        run.conversationId === input.conversationId &&
        run.ownerUserId === input.ownerUserId &&
        isActiveAgentRunStatus(run.status)
    );
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
      .sort((left, right) => `${left.updatedAt}:${left.id}`.localeCompare(`${right.updatedAt}:${right.id}`))
      .slice(0, input.limit);
  }

  async recoverStaleAgentRun(
    input: RecoverStaleAgentRunInput
  ): Promise<RecoverStaleAgentRunResult> {
    const run = await this.getAgentRun({
      clientInstanceId: input.clientInstanceId,
      runId: input.runId
    });
    if (!run || run.ownerUserId !== input.ownerUserId) {
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

  async appendRunObservation(input: AppendRunObservationInput): Promise<RunObservation> {
    const run = await this.getConversationAgentRun(input);
    if (!run || run.ownerUserId !== input.ownerUserId) {
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
      ownerUserId: input.ownerUserId,
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
    ownerUserId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<RunObservation[]> {
    const run = await this.getAgentRun(input);
    if (!run || run.ownerUserId !== input.ownerUserId) {
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
    for (const run of this.agentRuns.values()) {
      if (run.clientInstanceId === input.clientInstanceId && run.conversationId === input.conversationId) {
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

  private async requireOwnedActiveConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId,
    ownerUserId: string
  ): Promise<void> {
    const conversation = await this.getConversation(clientInstanceId, conversationId);
    if (
      !conversation ||
      conversation.status !== "active" ||
      conversation.ownerUserId !== ownerUserId
    ) {
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

function runStartCommandKey(input: {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  commandKind: string;
  idempotencyKey: string;
}): string {
  return [
    input.clientInstanceId,
    input.ownerUserId,
    input.commandKind,
    input.idempotencyKey
  ].join("\u0000");
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
