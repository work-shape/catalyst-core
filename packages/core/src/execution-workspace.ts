import {
  ENDED_AGENT_RUN_STATUSES,
  WORKSPACE_COMMAND_STATUSES
} from "@work-shape/catalyst-asset-schemas";
import type { ManagedArtifactImagePagesPreview, SubjectRowClaim } from "./files";
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
import type { WorkspaceCommandSkillMount } from "./skill-folders";
import type { ISODateString } from "./time";
import type { ProjectCommandFileChange } from "./project-files";
import type { ToolExecutionContext } from "./tool-execution";

export type ExecutionWorkspaceStatus = "active" | "deleted";

/**
 * What a file or command tool addresses its workspace by. The Execution Workspace of a
 * conversation is the only kind today.
 */
export type WorkspaceHandle = { kind: "execution_workspace"; id: ExecutionWorkspaceId };

/** The workspace record's conversation is attribution and retention, never the address. */
export interface ResolvedWorkspaceHandle {
  readonly handle: WorkspaceHandle;
  readonly conversationId: ConversationId;
}

export interface WorkspaceHandleResolver {
  /** Undefined when the call carries no tool request to resolve a workspace from. */
  resolveWorkspaceHandle(
    context: ToolExecutionContext
  ): Promise<ResolvedWorkspaceHandle | undefined>;
}

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

export type WorkspaceCommandStatus = (typeof WORKSPACE_COMMAND_STATUSES)[number];

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
  projectFileChanges?: ProjectCommandFileChange[];
  truncated: {
    stdout: boolean;
    stderr: boolean;
  };
}

export interface WorkspaceCommandResult {
  commandId: WorkspaceCommandId;
  status: Extract<WorkspaceCommandStatus, (typeof ENDED_AGENT_RUN_STATUSES)[number]>;
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
  /**
   * The skills the command mounts read-only at `/skills/<name>/`, fixed when it was queued.
   * Missing for a command without an agent run, whose sandbox has no `/skills`.
   */
  skillMounts?: WorkspaceCommandSkillMount[];
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
  /** The skills of the agent run, resolved by the caller when it queues the command. */
  skillMounts?: WorkspaceCommandSkillMount[];
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
  /**
   * The workspace a reading tool addresses: looked up, never created. Undefined when the
   * Conversation has none. Refuses with `NOT_FOUND` when the Conversation is not active, as
   * `ensureExecutionWorkspace` does.
   */
  findExecutionWorkspaceOfActiveConversation(input: {
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
  /** One file by its path. Its cost does not grow with the number of files in the workspace. */
  getWorkspaceFile(input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
    path: string;
  }): Promise<WorkspaceFile | undefined>;
}

/**
 * The kind of the job that runs one row of `workspace_commands`. It is named here because the
 * store that cancels a queued command withdraws the command's job in the same transaction.
 */
export const WORKSPACE_COMMAND_JOB_KIND = "workspace.command";

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
  /**
   * Asks a command to end. One that runs becomes `cancelling` and its worker ends it. One that
   * no worker claimed becomes `cancelled` at once and its queued job is withdrawn with it.
   */
  requestWorkspaceCommandCancellation(
    input: RequestWorkspaceCommandCancellationInput
  ): Promise<WorkspaceCommand>;
  /**
   * Gives up a command that no worker claimed, under the lock of its job: the command becomes
   * `cancelled` and its job is withdrawn. Resolves to nothing, and changes nothing, when a
   * worker holds the job or the command is not queued any more: its caller goes on waiting.
   */
  giveUpUnclaimedWorkspaceCommand(
    input: RequestWorkspaceCommandCancellationInput
  ): Promise<WorkspaceCommand | undefined>;
  /** Whether a command of the run is still queued: no worker has claimed it. */
  hasUnclaimedWorkspaceCommand(input: {
    clientInstanceId: ClientInstanceId;
    agentRunId: AgentRunId;
  }): Promise<boolean>;
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
