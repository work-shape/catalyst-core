import {
  type ClientInstanceId,
  type ExecutionWorkspace,
  type ExecutionWorkspaceCleanupStore,
  type ExecutionWorkspaceFileStore,
  type ExecutionWorkspaceId,
  type ExecutionWorkspaceMetadataStore,
  type ExecutionWorkspacesStore,
  type WorkspaceCommand,
  type WorkspaceCommandId,
  type WorkspaceCommandStore,
  type WorkspaceFile
} from "@work-shape/catalyst-core";
import { type PostgresConnection } from "./postgres-database";
import {
  listExecutionWorkspaceCleanupTargets,
  listExecutionWorkspaceObjectsForDeletion,
  markExecutionWorkspaceDeleted
} from "./postgres-execution-workspace-cleanup";
import {
  deleteWorkspaceFile,
  getWorkspaceFile,
  listWorkspaceFiles,
  upsertWorkspaceFile
} from "./postgres-execution-workspace-files";
import {
  ensureExecutionWorkspace,
  findExecutionWorkspaceOfActiveConversation,
  getExecutionWorkspace,
  getExecutionWorkspaceForConversation
} from "./postgres-execution-workspace-metadata";
import {
  cancelClaimedWorkspaceCommand,
  claimWorkspaceCommand,
  completeWorkspaceCommand,
  countActiveWorkspaceCommands,
  enqueueWorkspaceCommand,
  failWorkspaceCommand,
  getWorkspaceCommand,
  giveUpUnclaimedWorkspaceCommand,
  hasUnclaimedWorkspaceCommand,
  listWorkspaceCommandsWithoutJob,
  renewClaimedWorkspaceCommandLease,
  requestWorkspaceCommandCancellation
} from "./postgres-workspace-command-operations";

export function createPostgresExecutionWorkspacesStore(
  db: PostgresConnection
): ExecutionWorkspacesStore {
  return {
    async ensureExecutionWorkspace(
      input: Parameters<ExecutionWorkspaceMetadataStore["ensureExecutionWorkspace"]>[0]
    ): Promise<ExecutionWorkspace> {
      return ensureExecutionWorkspace(db, input);
    },
    async getExecutionWorkspace(input: {
      clientInstanceId: ClientInstanceId;
      workspaceId: ExecutionWorkspaceId;
    }): Promise<ExecutionWorkspace | undefined> {
      return getExecutionWorkspace(db, input);
    },
    async getExecutionWorkspaceForConversation(
      input: Parameters<ExecutionWorkspaceMetadataStore["getExecutionWorkspaceForConversation"]>[0]
    ): Promise<ExecutionWorkspace | undefined> {
      return getExecutionWorkspaceForConversation(db, input);
    },
    async findExecutionWorkspaceOfActiveConversation(
      input: Parameters<
        ExecutionWorkspaceMetadataStore["findExecutionWorkspaceOfActiveConversation"]
      >[0]
    ): Promise<ExecutionWorkspace | undefined> {
      return findExecutionWorkspaceOfActiveConversation(db, input);
    },
    async getWorkspaceFile(
      input: Parameters<ExecutionWorkspaceFileStore["getWorkspaceFile"]>[0]
    ): Promise<WorkspaceFile | undefined> {
      return getWorkspaceFile(db, input);
    },
    async upsertWorkspaceFile(
      input: Parameters<ExecutionWorkspaceFileStore["upsertWorkspaceFile"]>[0]
    ): Promise<WorkspaceFile> {
      return upsertWorkspaceFile(db, input);
    },
    async deleteWorkspaceFile(
      input: Parameters<ExecutionWorkspaceFileStore["deleteWorkspaceFile"]>[0]
    ): Promise<WorkspaceFile | undefined> {
      return deleteWorkspaceFile(db, input);
    },
    async listWorkspaceFiles(
      input: Parameters<ExecutionWorkspaceFileStore["listWorkspaceFiles"]>[0]
    ): Promise<WorkspaceFile[]> {
      return listWorkspaceFiles(db, input);
    },
    async countActiveWorkspaceCommands(
      input: Parameters<WorkspaceCommandStore["countActiveWorkspaceCommands"]>[0]
    ) {
      return countActiveWorkspaceCommands(db, input);
    },
    async enqueueWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["enqueueWorkspaceCommand"]>[0]
    ): Promise<WorkspaceCommand> {
      return enqueueWorkspaceCommand(db, input);
    },
    async getWorkspaceCommand(input: {
      clientInstanceId: ClientInstanceId;
      commandId: WorkspaceCommandId;
    }): Promise<WorkspaceCommand | undefined> {
      return getWorkspaceCommand(db, input);
    },
    async claimWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["claimWorkspaceCommand"]>[0]
    ) {
      return claimWorkspaceCommand(db, input);
    },
    async renewClaimedWorkspaceCommandLease(
      input: Parameters<WorkspaceCommandStore["renewClaimedWorkspaceCommandLease"]>[0]
    ) {
      return renewClaimedWorkspaceCommandLease(db, input);
    },
    async listWorkspaceCommandsWithoutJob(
      input: Parameters<WorkspaceCommandStore["listWorkspaceCommandsWithoutJob"]>[0]
    ) {
      return listWorkspaceCommandsWithoutJob(db, input);
    },
    async completeWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["completeWorkspaceCommand"]>[0]
    ): Promise<WorkspaceCommand> {
      return completeWorkspaceCommand(db, input);
    },
    async failWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["failWorkspaceCommand"]>[0]
    ): Promise<WorkspaceCommand> {
      return failWorkspaceCommand(db, input);
    },
    async requestWorkspaceCommandCancellation(
      input: Parameters<WorkspaceCommandStore["requestWorkspaceCommandCancellation"]>[0]
    ): Promise<WorkspaceCommand> {
      return requestWorkspaceCommandCancellation(db, input);
    },
    hasUnclaimedWorkspaceCommand: (input) => hasUnclaimedWorkspaceCommand(db, input),
    giveUpUnclaimedWorkspaceCommand: (input) => giveUpUnclaimedWorkspaceCommand(db, input),
    async cancelClaimedWorkspaceCommand(
      input: Parameters<WorkspaceCommandStore["cancelClaimedWorkspaceCommand"]>[0]
    ): Promise<WorkspaceCommand> {
      return cancelClaimedWorkspaceCommand(db, input);
    },
    async listExecutionWorkspaceCleanupTargets(
      input: Parameters<ExecutionWorkspaceCleanupStore["listExecutionWorkspaceCleanupTargets"]>[0]
    ) {
      return listExecutionWorkspaceCleanupTargets(db, input);
    },
    async listExecutionWorkspaceObjectsForDeletion(
      input: Parameters<
        ExecutionWorkspaceCleanupStore["listExecutionWorkspaceObjectsForDeletion"]
      >[0]
    ) {
      return listExecutionWorkspaceObjectsForDeletion(db, input);
    },
    async markExecutionWorkspaceDeleted(
      input: Parameters<ExecutionWorkspaceCleanupStore["markExecutionWorkspaceDeleted"]>[0]
    ) {
      return markExecutionWorkspaceDeleted(db, input);
    }
  };
}
export { withdrawUnclaimedWorkspaceCommandsOfRuns } from "./postgres-workspace-command-operations";
