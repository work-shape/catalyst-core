import type {
  AuditRecorder,
  ClientInstanceId,
  ConversationId,
  ManagedFileId,
  PlatformStores,
  ToolExecutionContext,
  WorkspaceCommand
} from "@vivd-catalyst/core";
import type { WorkspaceCommandTelemetry } from "../workspace-command-telemetry";
import type { WorkspaceFileByteStore, WorkspaceObjectStore } from "../workspace-file-bytes";
import { DEFAULT_LIMITS, type WorkspaceCommandServiceLimits } from "../workspace-tool-schemas";

export type WorkspaceToolStore = Pick<PlatformStores, "files" | "executionWorkspaces">;

export interface WorkspaceSourceFileReader {
  readSourceFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: string;
  }): Promise<{
    fileId: ManagedFileId;
    filename: string;
    mimeType?: string;
    byteSize: number;
    bytes: Uint8Array;
  }>;
}

export interface WorkspaceCommandResultSource {
  resolveWorkspaceCommand(input: {
    command: WorkspaceCommand;
    context: ToolExecutionContext;
  }): Promise<WorkspaceCommand | undefined>;
}

export interface WorkspaceCommandServiceOptions {
  store: Pick<PlatformStores, "files" | "executionWorkspaces">;
  objectStore?: WorkspaceObjectStore;
  fileStore?: WorkspaceFileByteStore;
  sourceFileReader?: WorkspaceSourceFileReader;
  commandResults?: WorkspaceCommandResultSource;
  auditRecorder?: AuditRecorder;
  telemetry?: WorkspaceCommandTelemetry;
  limits?: Partial<WorkspaceCommandServiceLimits>;
  execResultWaitMs?: number;
  execResultPollIntervalMs?: number;
  now?: () => string;
}

/** What every workspace tool works with: the service options with their defaults filled in. */
export interface WorkspaceToolDependencies {
  readonly store: Pick<PlatformStores, "files" | "executionWorkspaces">;
  readonly objectStore?: WorkspaceObjectStore;
  readonly fileStore?: WorkspaceFileByteStore;
  readonly sourceFileReader?: WorkspaceSourceFileReader;
  readonly commandResults?: WorkspaceCommandResultSource;
  readonly auditRecorder?: AuditRecorder;
  readonly telemetry?: WorkspaceCommandTelemetry;
  readonly limits: WorkspaceCommandServiceLimits;
  readonly execResultWaitMs?: number;
  readonly execResultPollIntervalMs: number;
  readonly now: () => string;
}

export function resolveWorkspaceToolDependencies(
  options: WorkspaceCommandServiceOptions
): WorkspaceToolDependencies {
  return {
    store: options.store,
    fileStore: options.fileStore,
    objectStore: options.objectStore ?? options.fileStore,
    sourceFileReader: options.sourceFileReader,
    commandResults: options.commandResults,
    auditRecorder: options.auditRecorder,
    telemetry: options.telemetry,
    limits: {
      ...DEFAULT_LIMITS,
      ...options.limits
    },
    execResultWaitMs: options.execResultWaitMs,
    execResultPollIntervalMs: options.execResultPollIntervalMs ?? 500,
    now: options.now ?? (() => new Date().toISOString())
  };
}
