import type {
  AuditRecorder,
  ClientInstanceId,
  ConversationId,
  ManagedFileId,
  ObjectStorage,
  PlatformStores,
  ToolExecutionContext,
  WorkspaceCommand
} from "@work-shape/catalyst-core";
import {
  createWorkspaceCommandClient,
  type WorkspaceCommandClient
} from "../workspace-command-client";
import type { WorkspaceSkillSource } from "../run-skills";
import type { WorkspaceCommandTelemetry } from "../workspace-command-telemetry";
import { DEFAULT_LIMITS, type WorkspaceCommandServiceLimits } from "../workspace-tool-schemas";
import {
  createExecutionWorkspaceHandleResolver,
  type ExecutionWorkspaceHandleResolver
} from "./workspace-handle-resolver";

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
  /** The stores of the process. A command and its job are queued in one transaction of them. */
  store: Pick<PlatformStores, "files" | "executionWorkspaces" | "jobs" | "transaction">;
  /** The `workspaces` store, for tools that only read file bytes. */
  objectStore?: ObjectStorage;
  /** The `workspaces` store, for tools that also write. It serves the reads when given alone. */
  fileStore?: ObjectStorage;
  sourceFileReader?: WorkspaceSourceFileReader;
  commandResults?: WorkspaceCommandResultSource;
  /**
   * The skills of an agent run, which its commands mount read-only at `/skills/<name>/`.
   * Without it no command mounts a skill.
   */
  skills?: WorkspaceSkillSource;
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
  readonly commands: WorkspaceCommandClient;
  readonly workspaces: ExecutionWorkspaceHandleResolver;
  readonly objectStore?: ObjectStorage;
  readonly fileStore?: ObjectStorage;
  readonly sourceFileReader?: WorkspaceSourceFileReader;
  readonly commandResults?: WorkspaceCommandResultSource;
  readonly skills?: WorkspaceSkillSource;
  readonly auditRecorder?: AuditRecorder;
  readonly telemetry?: WorkspaceCommandTelemetry;
  readonly limits: WorkspaceCommandServiceLimits;
  readonly now: () => string;
}

export function resolveWorkspaceToolDependencies(
  options: WorkspaceCommandServiceOptions
): WorkspaceToolDependencies {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    store: options.store,
    workspaces: createExecutionWorkspaceHandleResolver({
      store: options.store.executionWorkspaces,
      now
    }),
    commands: createWorkspaceCommandClient({
      stores: options.store,
      resultWaitMs: options.execResultWaitMs,
      resultPollIntervalMs: options.execResultPollIntervalMs,
      now
    }),
    fileStore: options.fileStore,
    objectStore: options.objectStore ?? options.fileStore,
    sourceFileReader: options.sourceFileReader,
    commandResults: options.commandResults,
    skills: options.skills,
    auditRecorder: options.auditRecorder,
    telemetry: options.telemetry,
    limits: {
      ...DEFAULT_LIMITS,
      ...options.limits
    },
    now
  };
}
