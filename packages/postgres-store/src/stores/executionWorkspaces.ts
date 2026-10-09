import {
  type ClientInstanceId,
  type ExecutionWorkspace,
  type ExecutionWorkspaceCleanupStore,
  type ExecutionWorkspaceFileStore,
  type ExecutionWorkspaceMetadataStore,
  type ExecutionWorkspaceId,
  type WorkspaceCommand,
  type WorkspaceCommandId,
  type WorkspaceCommandStore,
  type WorkspaceFile
} from "@vivd-catalyst/core";
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
} from "../postgres-execution-workspace-operations";
import type { ExecutionWorkspacesStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresExecutionWorkspacesStore(
  db: PostgresConnection
): ExecutionWorkspacesStore {
  return {
    async ensureExecutionWorkspace(
      input: Parameters<ExecutionWorkspaceMetadataStore["ensureExecutionWorkspace"]>[0]
    ): Promise<ExecutionWorkspace> {
      return ensurePostgresExecutionWorkspace(db, input);
    },
    async getExecutionWorkspace(input: {
      clientInstanceId: ClientInstanceId;
      workspaceId: ExecutionWorkspaceId;
    }): Promise<ExecutionWorkspace | undefined> {
      return getPostgresExecutionWorkspace(db, input);
    },
    async getExecutionWorkspaceForConversation(
      input: Parameters<ExecutionWorkspaceMetadataStore["getExecutionWorkspaceForConversation"]>[0]
    ): Promise<ExecutionWorkspace | undefined> {
      return getPostgresExecutionWorkspaceForConversation(db, input);
    },
    async upsertWorkspaceFile(
      input: Parameters<ExecutionWorkspaceFileStore["upsertWorkspaceFile"]>[0]
    ): Promise<WorkspaceFile> {
      return upsertPostgresWorkspaceFile(db, input);
    },
    async deleteWorkspaceFile(
      input: Parameters<ExecutionWorkspaceFileStore["deleteWorkspaceFile"]>[0]
    ): Promise<WorkspaceFile | undefined> {
      return deletePostgresWorkspaceFile(db, input);
    },
    async listWorkspaceFiles(
      input: Parameters<ExecutionWorkspaceFileStore["listWorkspaceFiles"]>[0]
    ): Promise<WorkspaceFile[]> {
      return listPostgresWorkspaceFiles(db, input);
    },
    async countActiveWorkspaceCommands(
      input: Parameters<WorkspaceCommandStore["countActiveWorkspaceCommands"]>[0]
    ) {
      return countActivePostgresWorkspaceCommands(db, input);
    },
    async enqueueWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["enqueueWorkspaceCommand"]>[0]
    ): Promise<WorkspaceCommand> {
      return enqueuePostgresWorkspaceCommand(db, input);
    },
    async getWorkspaceCommand(input: {
      clientInstanceId: ClientInstanceId;
      commandId: WorkspaceCommandId;
    }): Promise<WorkspaceCommand | undefined> {
      return getPostgresWorkspaceCommand(db, input);
    },
    async claimNextWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["claimNextWorkspaceCommand"]>[0]
    ): Promise<WorkspaceCommand | undefined> {
      return claimNextPostgresWorkspaceCommand(db, input);
    },
    async completeWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["completeWorkspaceCommand"]>[0]
    ): Promise<WorkspaceCommand> {
      return completePostgresWorkspaceCommand(db, input);
    },
    async failWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["failWorkspaceCommand"]>[0]
    ): Promise<WorkspaceCommand> {
      return failPostgresWorkspaceCommand(db, input);
    },
    async requestWorkspaceCommandCancellation(
      input: Parameters<WorkspaceCommandStore["requestWorkspaceCommandCancellation"]>[0]
    ): Promise<WorkspaceCommand> {
      return requestPostgresWorkspaceCommandCancellation(db, input);
    },
    async cancelClaimedWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["cancelClaimedWorkspaceCommand"]>[0]
    ): Promise<WorkspaceCommand> {
      return cancelClaimedPostgresWorkspaceCommand(db, input);
    },
    async heartbeatWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["heartbeatWorkspaceCommand"]>[0]
    ): Promise<WorkspaceCommand> {
      return heartbeatPostgresWorkspaceCommand(db, input);
    },
    async recoverStaleWorkspaceCommands(
      input: Parameters<WorkspaceCommandStore["recoverStaleWorkspaceCommands"]>[0]
    ): Promise<WorkspaceCommand[]> {
      return recoverStalePostgresWorkspaceCommands(db, input);
    },
    async listExecutionWorkspaceCleanupTargets(
      input: Parameters<ExecutionWorkspaceCleanupStore["listExecutionWorkspaceCleanupTargets"]>[0]
    ) {
      return listPostgresExecutionWorkspaceCleanupTargets(db, input);
    },
    async listExecutionWorkspaceObjectsForDeletion(
      input: Parameters<
        ExecutionWorkspaceCleanupStore["listExecutionWorkspaceObjectsForDeletion"]
      >[0]
    ) {
      return listPostgresExecutionWorkspaceObjectsForDeletion(db, input);
    },
    async markExecutionWorkspaceDeleted(
      input: Parameters<ExecutionWorkspaceCleanupStore["markExecutionWorkspaceDeleted"]>[0]
    ) {
      return markPostgresExecutionWorkspaceDeleted(db, input);
    }
  };
}
