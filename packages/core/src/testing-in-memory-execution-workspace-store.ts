import {
  AppError,
  type CancelClaimedWorkspaceCommandInput,
  type ClaimWorkspaceCommandInput,
  type ClientInstanceId,
  type CompleteWorkspaceCommandInput,
  type ConversationId,
  type EnqueueWorkspaceCommandInput,
  type ExecutionWorkspace,
  type ExecutionWorkspaceFileStore,
  type ExecutionWorkspaceId,
  type ExecutionWorkspaceMetadataStore,
  type FailWorkspaceCommandInput,
  type RecoverStaleWorkspaceCommandsInput,
  type RequestWorkspaceCommandCancellationInput,
  type WorkspaceCommand,
  type WorkspaceCommandId,
  type WorkspaceCommandStore,
  type WorkspaceFile,
  createPlatformId
} from "./index";

export type InMemoryExecutionWorkspaceStore = ExecutionWorkspaceMetadataStore &
  ExecutionWorkspaceFileStore &
  WorkspaceCommandStore;

export interface InMemoryExecutionWorkspaceStoreCallbacks {
  requireOwnedActiveConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId,
    ownerUserId: string
  ): Promise<void>;
}

export function createInMemoryExecutionWorkspaceStore(
  callbacks: InMemoryExecutionWorkspaceStoreCallbacks
): InMemoryExecutionWorkspaceStore {
  return new InMemoryExecutionWorkspaceStoreImpl(callbacks);
}

class InMemoryExecutionWorkspaceStoreImpl implements InMemoryExecutionWorkspaceStore {
  private readonly executionWorkspaces = new Map<string, ExecutionWorkspace>();
  private readonly workspaceFiles = new Map<string, WorkspaceFile>();
  private readonly workspaceCommands = new Map<string, WorkspaceCommand>();

  constructor(private readonly callbacks: InMemoryExecutionWorkspaceStoreCallbacks) {}

  async ensureExecutionWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    ownerUserId: string;
    now?: string;
  }): Promise<ExecutionWorkspace> {
    await this.callbacks.requireOwnedActiveConversation(
      input.clientInstanceId,
      input.conversationId,
      input.ownerUserId
    );

    const existing = await this.getExecutionWorkspaceForConversation(input);
    if (existing) {
      return existing;
    }

    const now = input.now ?? new Date().toISOString();
    const workspace: ExecutionWorkspace = {
      id: createPlatformId("ews"),
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.executionWorkspaces.set(workspace.id, workspace);
    return workspace;
  }

  async getExecutionWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
  }): Promise<ExecutionWorkspace | undefined> {
    const workspace = this.executionWorkspaces.get(input.workspaceId);
    if (
      !workspace ||
      workspace.clientInstanceId !== input.clientInstanceId ||
      workspace.status === "deleted"
    ) {
      return undefined;
    }
    return workspace;
  }

  async getExecutionWorkspaceForConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ExecutionWorkspace | undefined> {
    return [...this.executionWorkspaces.values()].find(
      (workspace) =>
        workspace.clientInstanceId === input.clientInstanceId &&
        workspace.conversationId === input.conversationId &&
        workspace.status !== "deleted"
    );
  }

  async upsertWorkspaceFile(input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
    path: string;
    objectKey: string;
    byteSize: number;
    checksum: string;
    mimeType?: string;
    metadata?: WorkspaceFile["metadata"];
    lastCommandId?: WorkspaceCommandId;
    updatedAt?: string;
  }): Promise<WorkspaceFile> {
    const workspace = await this.requireActiveWorkspace(input.clientInstanceId, input.workspaceId);
    const now = input.updatedAt ?? new Date().toISOString();
    const key = workspaceFileKey(input.workspaceId, input.path);
    const existing = this.workspaceFiles.get(key);
    const file: WorkspaceFile = {
      workspaceId: input.workspaceId,
      clientInstanceId: input.clientInstanceId,
      conversationId: workspace.conversationId,
      path: input.path,
      objectKey: input.objectKey,
      byteSize: input.byteSize,
      checksum: input.checksum,
      mimeType: input.mimeType,
      metadata: input.metadata ?? {},
      lastCommandId: input.lastCommandId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.workspaceFiles.set(key, file);
    this.executionWorkspaces.set(workspace.id, {
      ...workspace,
      updatedAt: now
    });
    return file;
  }

  async listWorkspaceFiles(input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
  }): Promise<WorkspaceFile[]> {
    return [...this.workspaceFiles.values()]
      .filter(
        (file) =>
          file.clientInstanceId === input.clientInstanceId && file.workspaceId === input.workspaceId
      )
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async enqueueWorkspaceCommand(input: EnqueueWorkspaceCommandInput): Promise<WorkspaceCommand> {
    const workspace = await this.requireActiveWorkspace(
      input.clientInstanceId,
      input.workspaceId,
      input.ownerUserId
    );
    const queuedAt = input.queuedAt ?? new Date().toISOString();
    const command: WorkspaceCommand = {
      id: createPlatformId("wcmd"),
      workspaceId: input.workspaceId,
      clientInstanceId: input.clientInstanceId,
      conversationId: workspace.conversationId,
      ownerUserId: input.ownerUserId,
      agentRunId: input.agentRunId,
      toolCallId: input.toolCallId,
      command: input.command,
      cwd: input.cwd,
      status: "queued",
      limits: input.limits,
      expectedOutputs: input.expectedOutputs ?? [],
      attempts: 0,
      queuedAt,
      updatedAt: queuedAt
    };
    this.workspaceCommands.set(command.id, command);
    this.executionWorkspaces.set(workspace.id, {
      ...workspace,
      updatedAt: queuedAt
    });
    return command;
  }

  async getWorkspaceCommand(input: {
    clientInstanceId: ClientInstanceId;
    commandId: WorkspaceCommandId;
  }): Promise<WorkspaceCommand | undefined> {
    const command = this.workspaceCommands.get(input.commandId);
    if (!command || command.clientInstanceId !== input.clientInstanceId) {
      return undefined;
    }
    return command;
  }

  async claimNextWorkspaceCommand(
    input: ClaimWorkspaceCommandInput
  ): Promise<WorkspaceCommand | undefined> {
    const candidate = [...this.workspaceCommands.values()]
      .filter((command) => {
        const workspace = this.executionWorkspaces.get(command.workspaceId);
        return (
          command.clientInstanceId === input.clientInstanceId &&
          command.status === "queued" &&
          workspace?.status === "active"
        );
      })
      .sort((left, right) =>
        `${left.queuedAt}:${left.id}`.localeCompare(`${right.queuedAt}:${right.id}`)
      )[0];
    if (!candidate) {
      return undefined;
    }
    const claimed: WorkspaceCommand = {
      ...candidate,
      status: "running",
      leaseOwner: input.workerId,
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      heartbeatAt: input.now,
      startedAt: candidate.startedAt ?? input.now,
      attempts: candidate.attempts + 1,
      error: undefined,
      updatedAt: input.now
    };
    this.workspaceCommands.set(claimed.id, claimed);
    return claimed;
  }

  async completeWorkspaceCommand(input: CompleteWorkspaceCommandInput): Promise<WorkspaceCommand> {
    const command = this.requireClaimedWorkspaceCommand(input.commandId, input.leaseToken, [
      "running"
    ]);
    if (command.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("CONFLICT", "Workspace command lease is no longer active");
    }
    const completed: WorkspaceCommand = {
      ...command,
      status: "completed",
      output: input.output,
      error: undefined,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      completedAt: input.completedAt,
      updatedAt: input.completedAt
    };
    this.workspaceCommands.set(completed.id, completed);
    return completed;
  }

  async failWorkspaceCommand(input: FailWorkspaceCommandInput): Promise<WorkspaceCommand> {
    const command = this.requireClaimedWorkspaceCommand(input.commandId, input.leaseToken, [
      "running",
      "cancelling"
    ]);
    if (command.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("CONFLICT", "Workspace command lease is no longer active");
    }
    const failed: WorkspaceCommand = {
      ...command,
      status: "failed",
      output: input.output,
      error: input.error,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      completedAt: input.failedAt,
      updatedAt: input.failedAt
    };
    this.workspaceCommands.set(failed.id, failed);
    return failed;
  }

  async requestWorkspaceCommandCancellation(
    input: RequestWorkspaceCommandCancellationInput
  ): Promise<WorkspaceCommand> {
    const command = this.workspaceCommands.get(input.commandId);
    if (!command || command.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("NOT_FOUND", "Workspace command is not available");
    }
    if (isTerminalWorkspaceCommand(command)) {
      throw new AppError("CONFLICT", "Workspace command is already terminal");
    }
    const queuedCancellation = command.status === "queued";
    const updated: WorkspaceCommand = {
      ...command,
      status: queuedCancellation ? "cancelled" : "cancelling",
      cancellationReason: input.reason,
      cancellationRequestedAt: input.requestedAt,
      leaseOwner: queuedCancellation ? undefined : command.leaseOwner,
      leaseToken: queuedCancellation ? undefined : command.leaseToken,
      leaseExpiresAt: queuedCancellation ? undefined : command.leaseExpiresAt,
      heartbeatAt: queuedCancellation ? undefined : command.heartbeatAt,
      completedAt: queuedCancellation ? input.requestedAt : command.completedAt,
      updatedAt: input.requestedAt
    };
    this.workspaceCommands.set(updated.id, updated);
    return updated;
  }

  async cancelClaimedWorkspaceCommand(
    input: CancelClaimedWorkspaceCommandInput
  ): Promise<WorkspaceCommand> {
    const command = this.requireClaimedWorkspaceCommand(input.commandId, input.leaseToken, [
      "running",
      "cancelling"
    ]);
    if (command.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("CONFLICT", "Workspace command lease is no longer active");
    }
    const cancelled: WorkspaceCommand = {
      ...command,
      status: "cancelled",
      cancellationReason: input.reason,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      completedAt: input.cancelledAt,
      updatedAt: input.cancelledAt
    };
    this.workspaceCommands.set(cancelled.id, cancelled);
    return cancelled;
  }

  async recoverStaleWorkspaceCommands(
    input: RecoverStaleWorkspaceCommandsInput
  ): Promise<WorkspaceCommand[]> {
    const stale = [...this.workspaceCommands.values()]
      .filter(
        (command) =>
          command.clientInstanceId === input.clientInstanceId &&
          (command.status === "running" || command.status === "cancelling") &&
          command.leaseExpiresAt !== undefined &&
          command.leaseExpiresAt < input.staleLeaseExpiredBefore
      )
      .sort((left, right) =>
        `${left.leaseExpiresAt ?? ""}:${left.id}`.localeCompare(
          `${right.leaseExpiresAt ?? ""}:${right.id}`
        )
      )
      .slice(0, input.limit);
    const recovered = stale.map((command): WorkspaceCommand => ({
      ...command,
      status: "failed",
      error: input.error,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      completedAt: input.recoveredAt,
      updatedAt: input.recoveredAt
    }));
    for (const command of recovered) {
      this.workspaceCommands.set(command.id, command);
    }
    return recovered;
  }

  private async requireActiveWorkspace(
    clientInstanceId: ClientInstanceId,
    workspaceId: ExecutionWorkspaceId,
    ownerUserId?: string
  ): Promise<ExecutionWorkspace> {
    const workspace = await this.getExecutionWorkspace({ clientInstanceId, workspaceId });
    if (!workspace || (ownerUserId !== undefined && workspace.ownerUserId !== ownerUserId)) {
      throw new AppError("NOT_FOUND", "Execution workspace is not available");
    }
    return workspace;
  }

  private requireClaimedWorkspaceCommand(
    commandId: WorkspaceCommandId,
    leaseToken: string,
    statuses: WorkspaceCommand["status"][]
  ): WorkspaceCommand {
    const command = this.workspaceCommands.get(commandId);
    if (
      !command ||
      command.leaseToken !== leaseToken ||
      !statuses.includes(command.status)
    ) {
      throw new AppError("CONFLICT", "Workspace command lease is no longer active");
    }
    return command;
  }
}

function workspaceFileKey(workspaceId: ExecutionWorkspaceId, path: string): string {
  return `${workspaceId}:${path}`;
}

function isTerminalWorkspaceCommand(command: WorkspaceCommand): boolean {
  return (
    command.status === "completed" ||
    command.status === "failed" ||
    command.status === "cancelled"
  );
}
