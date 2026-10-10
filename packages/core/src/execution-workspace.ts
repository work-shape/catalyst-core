import type {
  AgentRunId,
  ClientInstanceId,
  ConversationId,
  ExecutionWorkspaceId,
  ManagedArtifactId,
  ToolCallId,
  WorkspaceCommandId
} from "./ids";
import type { ManagedArtifactImagePagesPreview, SubjectRowClaim } from "./files";
import type { JsonObject, JsonValue } from "./json";
import type { ISODateString } from "./time";

export type ExecutionWorkspaceStatus = "active" | "deleted";

/**
 * What a file or command tool addresses its workspace by. The Execution Workspace of a
 * conversation is the only kind today.
 */
export type WorkspaceHandle = { kind: "execution_workspace"; id: ExecutionWorkspaceId };

export interface ExecutionWorkspace {
  id: ExecutionWorkspaceId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  ownerUserId: string;
  status: ExecutionWorkspaceStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt?: ISODateString;
}

export interface WorkspaceFile {
  workspaceId: ExecutionWorkspaceId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  path: string;
  objectKey: string;
  byteSize: number;
  checksum: string;
  mimeType?: string;
  metadata: JsonObject;
  lastCommandId?: WorkspaceCommandId;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt?: ISODateString;
}

export type WorkspaceCommandStatus =
  "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface WorkspaceCommandLimits {
  timeoutSeconds: number;
  idleTimeoutSeconds?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxWorkspaceBytes?: number;
}

export interface WorkspaceExpectedOutput {
  path: string;
  kind?: string;
  promote?: boolean;
}

export interface WorkspaceCommandChangedFile {
  path: string;
  byteSize: number;
  checksum: string;
  objectKey?: string;
  mimeType?: string;
  artifactId?: ManagedArtifactId;
}

export interface WorkspaceCommandPromotedArtifact {
  artifactId: ManagedArtifactId;
  path: string;
  kind: string;
  mimeType?: string;
  metadata?: {
    preview?: ManagedArtifactImagePagesPreview;
  };
}

export interface WorkspaceCommandOutput {
  exitCode: number;
  stdoutPreview: string;
  stderrPreview: string;
  durationMs: number;
  changedFiles: WorkspaceCommandChangedFile[];
  promotedArtifacts: WorkspaceCommandPromotedArtifact[];
  truncated: {
    stdout: boolean;
    stderr: boolean;
  };
}

export interface WorkspaceCommandResult {
  commandId: WorkspaceCommandId;
  status: Extract<WorkspaceCommandStatus, "completed" | "failed" | "cancelled">;
  output?: WorkspaceCommandOutput;
  error?: WorkspaceCommandError;
}

export type WorkspaceCommandFailureCategory =
  "runner_error" | "timeout" | "cancelled" | "stale_lease" | "worker_lost" | "internal_error";

export interface WorkspaceCommandError {
  code: string;
  message: string;
  category: WorkspaceCommandFailureCategory;
  details?: JsonValue;
}

export interface WorkspaceCommand {
  id: WorkspaceCommandId;
  workspaceId: ExecutionWorkspaceId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  ownerUserId: string;
  agentRunId?: AgentRunId;
  toolCallId?: ToolCallId;
  command: string;
  cwd?: string;
  status: WorkspaceCommandStatus;
  limits: WorkspaceCommandLimits;
  expectedOutputs: WorkspaceExpectedOutput[];
  output?: WorkspaceCommandOutput;
  error?: WorkspaceCommandError;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: ISODateString;
  heartbeatAt?: ISODateString;
  attempts: number;
  cancellationReason?: string;
  cancellationRequestedAt?: ISODateString;
  queuedAt: ISODateString;
  startedAt?: ISODateString;
  completedAt?: ISODateString;
  updatedAt: ISODateString;
}

export interface EnsureExecutionWorkspaceInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  ownerUserId: string;
  now?: ISODateString;
}

export interface UpsertWorkspaceFileInput {
  clientInstanceId: ClientInstanceId;
  workspaceId: ExecutionWorkspaceId;
  path: string;
  objectKey: string;
  byteSize: number;
  checksum: string;
  mimeType?: string;
  metadata?: JsonObject;
  lastCommandId?: WorkspaceCommandId;
  updatedAt?: ISODateString;
}

export interface DeleteWorkspaceFileInput {
  clientInstanceId: ClientInstanceId;
  workspaceId: ExecutionWorkspaceId;
  path: string;
  lastCommandId?: WorkspaceCommandId;
  deletedAt?: ISODateString;
}

export interface EnqueueWorkspaceCommandInput {
  clientInstanceId: ClientInstanceId;
  workspaceId: ExecutionWorkspaceId;
  ownerUserId: string;
  agentRunId?: AgentRunId;
  toolCallId?: ToolCallId;
  command: string;
  cwd?: string;
  limits: WorkspaceCommandLimits;
  expectedOutputs?: WorkspaceExpectedOutput[];
  queuedAt?: ISODateString;
}

export interface ClaimWorkspaceCommandInput {
  clientInstanceId: ClientInstanceId;
  commandId: WorkspaceCommandId;
  /** Names the executor job, so the job takes back a row an earlier attempt of it left. */
  leaseOwnerId: string;
  leaseToken: string;
  leaseMs: number;
}

export interface RenewClaimedWorkspaceCommandLeaseInput {
  clientInstanceId: ClientInstanceId;
  commandId: WorkspaceCommandId;
  leaseToken: string;
  leaseMs: number;
}

export interface CompleteWorkspaceCommandInput {
  clientInstanceId: ClientInstanceId;
  commandId: WorkspaceCommandId;
  leaseToken: string;
  output: WorkspaceCommandOutput;
  completedAt: ISODateString;
}

export interface FailWorkspaceCommandInput {
  clientInstanceId: ClientInstanceId;
  commandId: WorkspaceCommandId;
  leaseToken: string;
  error: WorkspaceCommandError;
  output?: WorkspaceCommandOutput;
  failedAt: ISODateString;
}

export interface RequestWorkspaceCommandCancellationInput {
  clientInstanceId: ClientInstanceId;
  commandId: WorkspaceCommandId;
  reason?: string;
  requestedAt: ISODateString;
}

export interface CancelClaimedWorkspaceCommandInput {
  clientInstanceId: ClientInstanceId;
  commandId: WorkspaceCommandId;
  leaseToken: string;
  reason?: string;
  output?: WorkspaceCommandOutput;
  cancelledAt: ISODateString;
}

export interface CountActiveWorkspaceCommandsInput {
  clientInstanceId: ClientInstanceId;
  conversationId?: ConversationId;
  ownerUserId?: string;
}

export interface ActiveWorkspaceCommandCounts {
  queued: number;
  running: number;
  cancelling: number;
  total: number;
}

export interface ExecutionWorkspaceDeletionSummary {
  workspaceCount: number;
  fileCount: number;
  commandCount: number;
  fileObjectKeys: string[];
}

export interface ExecutionWorkspaceCleanupTarget {
  workspaceId: ExecutionWorkspaceId;
  conversationId: ConversationId;
}

export interface ListExecutionWorkspaceCleanupTargetsInput {
  clientInstanceId: ClientInstanceId;
  limit: number;
}

export interface ListExecutionWorkspaceObjectsForDeletionInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
}

export interface MarkExecutionWorkspaceDeletedInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  deletedAt: ISODateString;
}

export interface ExecutionWorkspaceMetadataStore {
  ensureExecutionWorkspace(input: EnsureExecutionWorkspaceInput): Promise<ExecutionWorkspace>;
  getExecutionWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
  }): Promise<ExecutionWorkspace | undefined>;
  getExecutionWorkspaceForConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ExecutionWorkspace | undefined>;
}

export interface ExecutionWorkspaceFileStore {
  upsertWorkspaceFile(input: UpsertWorkspaceFileInput): Promise<WorkspaceFile>;
  deleteWorkspaceFile(input: DeleteWorkspaceFileInput): Promise<WorkspaceFile | undefined>;
  listWorkspaceFiles(input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
  }): Promise<WorkspaceFile[]>;
}

export interface WorkspaceCommandStore {
  countActiveWorkspaceCommands(
    input: CountActiveWorkspaceCommandsInput
  ): Promise<ActiveWorkspaceCommandCounts>;
  enqueueWorkspaceCommand(input: EnqueueWorkspaceCommandInput): Promise<WorkspaceCommand>;
  getWorkspaceCommand(input: {
    clientInstanceId: ClientInstanceId;
    commandId: WorkspaceCommandId;
  }): Promise<WorkspaceCommand | undefined>;
  /**
   * Takes a command by id for the executor job that drives it and writes the job's lease onto
   * the row. The row is taken when it is queued, and also when it was running and nobody holds
   * it any more: its lease ran out, or `leaseOwnerId` already holds it. Such a row comes back
   * with `attempts` above 1. It ran before and is not run again; the caller fails it.
   */
  claimWorkspaceCommand(
    input: ClaimWorkspaceCommandInput
  ): Promise<SubjectRowClaim<WorkspaceCommand>>;
  /**
   * Transition release only: extends the lease copied onto the row, which a worker of the
   * previous release reads. False when the row is no longer held under `leaseToken`.
   */
  renewClaimedWorkspaceCommandLease(
    input: RenewClaimedWorkspaceCommandLeaseInput
  ): Promise<boolean>;
  /**
   * Transition release only: the commands that are not finished and have no queued or running
   * job of `jobKind`, oldest first. An API of the previous release queued them, or a worker of
   * it left them behind.
   */
  listWorkspaceCommandsWithoutJob(input: {
    clientInstanceId: ClientInstanceId;
    jobKind: string;
    limit: number;
  }): Promise<Array<Pick<WorkspaceCommand, "id" | "workspaceId">>>;
  completeWorkspaceCommand(input: CompleteWorkspaceCommandInput): Promise<WorkspaceCommand>;
  failWorkspaceCommand(input: FailWorkspaceCommandInput): Promise<WorkspaceCommand>;
  requestWorkspaceCommandCancellation(
    input: RequestWorkspaceCommandCancellationInput
  ): Promise<WorkspaceCommand>;
  cancelClaimedWorkspaceCommand(
    input: CancelClaimedWorkspaceCommandInput
  ): Promise<WorkspaceCommand>;
}

export interface ExecutionWorkspaceCleanupStore {
  listExecutionWorkspaceCleanupTargets(
    input: ListExecutionWorkspaceCleanupTargetsInput
  ): Promise<ExecutionWorkspaceCleanupTarget[]>;
  listExecutionWorkspaceObjectsForDeletion(
    input: ListExecutionWorkspaceObjectsForDeletionInput
  ): Promise<ExecutionWorkspaceDeletionSummary>;
  markExecutionWorkspaceDeleted(
    input: MarkExecutionWorkspaceDeletedInput
  ): Promise<ExecutionWorkspaceDeletionSummary>;
}
