import type {
  AgentRunId,
  ClientInstanceId,
  ConversationId,
  ExecutionWorkspaceId,
  ManagedArtifactId,
  ToolCallId,
  WorkspaceCommandId
} from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { ISODateString } from "./time";

export type ExecutionWorkspaceStatus = "active" | "deleted";

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
}

export type WorkspaceCommandStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

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
  | "runner_error"
  | "timeout"
  | "cancelled"
  | "stale_lease"
  | "internal_error";

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
  capacity?: WorkspaceCommandCapacityLimits;
  queuedAt?: ISODateString;
}

export interface ClaimWorkspaceCommandInput {
  clientInstanceId: ClientInstanceId;
  workerId: string;
  leaseToken: string;
  now: ISODateString;
  leaseExpiresAt: ISODateString;
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

export interface HeartbeatWorkspaceCommandInput {
  clientInstanceId: ClientInstanceId;
  commandId: WorkspaceCommandId;
  leaseToken: string;
  heartbeatAt: ISODateString;
  leaseExpiresAt: ISODateString;
}

export interface RecoverStaleWorkspaceCommandsInput {
  clientInstanceId: ClientInstanceId;
  staleLeaseExpiredBefore: ISODateString;
  recoveredAt: ISODateString;
  error: WorkspaceCommandError;
  limit: number;
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

export interface WorkspaceCommandCapacityLimits {
  perConversationActiveCommands: number;
  perUserActiveCommands: number;
  globalActiveCommands: number;
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
  claimNextWorkspaceCommand(input: ClaimWorkspaceCommandInput): Promise<WorkspaceCommand | undefined>;
  completeWorkspaceCommand(input: CompleteWorkspaceCommandInput): Promise<WorkspaceCommand>;
  failWorkspaceCommand(input: FailWorkspaceCommandInput): Promise<WorkspaceCommand>;
  requestWorkspaceCommandCancellation(
    input: RequestWorkspaceCommandCancellationInput
  ): Promise<WorkspaceCommand>;
  cancelClaimedWorkspaceCommand(input: CancelClaimedWorkspaceCommandInput): Promise<WorkspaceCommand>;
  heartbeatWorkspaceCommand(input: HeartbeatWorkspaceCommandInput): Promise<WorkspaceCommand>;
  recoverStaleWorkspaceCommands(
    input: RecoverStaleWorkspaceCommandsInput
  ): Promise<WorkspaceCommand[]>;
}
