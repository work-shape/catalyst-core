import {
  type AuditRecorder,
  type ExecutionWorkspace,
  type JobControl,
  type JsonObject,
  type ObjectStorage,
  type PlatformStores,
  type WorkspaceCommand,
  type WorkspaceCommandChangedFile,
  type WorkspaceCommandError,
  type WorkspaceCommandOutput,
  type WorkspaceCommandPromotedArtifact,
  type WorkspaceFile
} from "@work-shape/catalyst-core";
import { randomUUID } from "node:crypto";
import { readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readToolExecutionEnv } from "./env";
import { promoteWorkspaceFile } from "./workspace-artifact-promotion";
import {
  toWorkspaceCommandError,
  workspaceCommandError,
  WorkspaceRunnerFailure
} from "./workspace-command-errors";
import {
  LocalWorkspaceCommandProcessExecutor,
  type ProcessResult,
  type WorkspaceCommandProcessExecutor
} from "./workspace-command-executor";
import {
  ensureStandardWorkspaceDirectories,
  hydrateWorkspace,
  scanWorkspaceFiles,
  type HydratedWorkspace,
  type ScannedWorkspaceFile
} from "./workspace-command-files";
import {
  emitWorkspaceCommandTelemetry,
  recordWorkspaceCommandLifecycleAudit,
  terminalWorkspaceCommandAuditType,
  workspaceCommandTelemetryEvent,
  type WorkspaceCommandTelemetry
} from "./workspace-command-telemetry";
import { putWorkspaceFile, upsertStoredWorkspaceFile } from "./workspace-file-bytes";
import { normalizeWorkspaceDirectory, resolveWorkspaceFilesystemPath } from "./workspace-paths";

const DEFAULT_MAX_PATH_LENGTH = 512;

export type WorkspaceCommandRunnerStore = Pick<PlatformStores, "files" | "executionWorkspaces">;

export interface LocalWorkspaceCommandRunnerOptions {
  store: Pick<PlatformStores, "files" | "executionWorkspaces">;
  /** The `workspaces` store. */
  byteStore: ObjectStorage;
  workerId?: string;
  tempRootDirectory?: string;
  maxPathLength?: number;
  reuseWorkspaceDirectories?: boolean;
  shellPath?: string;
  processExecutor?: WorkspaceCommandProcessExecutor;
  auditRecorder?: AuditRecorder;
  telemetry?: WorkspaceCommandTelemetry;
  now?: () => string;
}

interface CommandExecutionResult {
  output?: WorkspaceCommandOutput;
  error?: WorkspaceCommandError;
  cancelled?: boolean;
}

interface SyncedWorkspaceFile {
  file: WorkspaceFile;
  output: WorkspaceCommandChangedFile;
}

export interface RunClaimedWorkspaceCommandOptions {
  /** Aborting it ends the process group; the command is then recorded as cancelled. */
  signal?: AbortSignal;
  /**
   * The fenced transaction of the job that holds the command. The command's final state is
   * written inside it, so a job that lost its lease records nothing.
   */
  transaction?: JobControl["transaction"];
}

export class LocalWorkspaceCommandRunner {
  private readonly store: Pick<PlatformStores, "files" | "executionWorkspaces">;
  private readonly byteStore: ObjectStorage;
  private readonly workerId: string;
  private readonly tempRootDirectory: string;
  private readonly maxPathLength: number;
  private readonly reuseWorkspaceDirectories: boolean;
  private readonly processExecutor: WorkspaceCommandProcessExecutor;
  private readonly auditRecorder?: AuditRecorder;
  private readonly telemetry?: WorkspaceCommandTelemetry;
  private readonly now: () => string;
  private readonly activeExecutionDirectories = new Set<string>();

  constructor(options: LocalWorkspaceCommandRunnerOptions) {
    this.store = options.store;
    this.byteStore = options.byteStore;
    this.workerId = options.workerId ?? `local-workspace-runner-${randomUUID()}`;
    this.tempRootDirectory = options.tempRootDirectory ?? tmpdir();
    this.maxPathLength = options.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH;
    this.reuseWorkspaceDirectories = options.reuseWorkspaceDirectories ?? false;
    this.processExecutor =
      options.processExecutor ??
      new LocalWorkspaceCommandProcessExecutor({ shellPath: options.shellPath });
    this.auditRecorder = options.auditRecorder;
    this.telemetry = options.telemetry;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runClaimedCommand(
    command: WorkspaceCommand,
    options: RunClaimedWorkspaceCommandOptions = {}
  ): Promise<WorkspaceCommand> {
    const leaseToken = command.leaseToken;
    if (!leaseToken) {
      throw new Error("Workspace command must be claimed before local execution");
    }

    const result = await this.executeCommand(command, options);
    const held = {
      clientInstanceId: command.clientInstanceId,
      commandId: command.id,
      leaseToken
    };
    const completedAt = this.now();
    const record = (commands: PlatformStores["executionWorkspaces"]): Promise<WorkspaceCommand> => {
      if (result.cancelled) {
        return commands.cancelClaimedWorkspaceCommand({
          ...held,
          reason: result.error?.message,
          output: result.output,
          cancelledAt: completedAt
        });
      }
      if (result.error) {
        return commands.failWorkspaceCommand({
          ...held,
          error: result.error,
          output: result.output,
          failedAt: completedAt
        });
      }
      if (!result.output) {
        return commands.failWorkspaceCommand({
          ...held,
          error: workspaceCommandError(
            "WORKSPACE_COMMAND_RUNNER_ERROR",
            "Workspace command runner did not produce an output",
            "internal_error"
          ),
          failedAt: completedAt
        });
      }
      return commands.completeWorkspaceCommand({
        ...held,
        output: result.output,
        completedAt
      });
    };
    const terminal = await (options.transaction
      ? options.transaction((stores) => record(stores.executionWorkspaces))
      : record(this.store.executionWorkspaces));
    await this.recordTerminalCommand(terminal);
    return terminal;
  }

  async cleanupIdleWorkspaceDirectories(input: {
    olderThanMs: number;
    now?: Date;
  }): Promise<{ removedCount: number; failedCount: number }> {
    let entries;
    try {
      entries = await readdir(this.tempRootDirectory, { withFileTypes: true });
    } catch {
      return { removedCount: 0, failedCount: 0 };
    }

    const cutoffMs = (input.now ?? new Date()).getTime() - input.olderThanMs;
    let removedCount = 0;
    let failedCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("catalyst-workspace-")) {
        continue;
      }
      const directory = join(this.tempRootDirectory, entry.name);
      if (this.activeExecutionDirectories.has(directory)) {
        continue;
      }
      try {
        const info = await stat(directory);
        if (info.mtimeMs > cutoffMs) {
          continue;
        }
        await rm(directory, { recursive: true, force: true });
        removedCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    return { removedCount, failedCount };
  }

  private async recordTerminalCommand(command: WorkspaceCommand): Promise<void> {
    const auditType = terminalWorkspaceCommandAuditType(command);
    await recordWorkspaceCommandLifecycleAudit({
      auditRecorder: this.auditRecorder,
      type: auditType.type,
      status: auditType.status,
      command,
      metadata: terminalCommandAuditMetadata(command)
    });
    await emitWorkspaceCommandTelemetry(
      this.telemetry,
      workspaceCommandTelemetryEvent(auditType.telemetryType, command, {
        workerId: this.workerId
      })
    );
  }

  private async executeCommand(
    command: WorkspaceCommand,
    options: RunClaimedWorkspaceCommandOptions
  ): Promise<CommandExecutionResult> {
    let hydrated: HydratedWorkspace | undefined;
    let processResult: ProcessResult | undefined;
    let changedFiles: WorkspaceCommandChangedFile[] = [];
    let promotedArtifacts: WorkspaceCommandPromotedArtifact[] = [];
    let cacheReusable = false;
    try {
      const workspace = await this.requireWorkspace(command);
      hydrated = await this.hydrateWorkspace(workspace, command);
      this.activeExecutionDirectories.add(hydrated.executionDirectory);
      processResult = await this.runProcess(
        command,
        hydrated.workspaceDirectory,
        join(hydrated.executionDirectory, "tmp"),
        options.signal
      );
      const scannedFiles = await this.scanWorkspaceFiles(hydrated.workspaceDirectory, command);
      const syncedFiles = await this.syncChangedFiles(
        workspace,
        command,
        hydrated.baselineFiles,
        scannedFiles
      );
      changedFiles = syncedFiles.map((changed) => changed.output);
      cacheReusable = true;
      promotedArtifacts = await this.promoteExpectedOutputs(
        command,
        syncedFiles,
        hydrated.workspaceDirectory
      );
      const output = commandOutputFromProcess(processResult, changedFiles, promotedArtifacts);
      const processError = this.processError(command, processResult);
      return {
        output,
        error: processError,
        cancelled: processResult.cancelled
      };
    } catch (error) {
      return {
        output: processResult
          ? commandOutputFromProcess(processResult, changedFiles, promotedArtifacts)
          : undefined,
        error: toWorkspaceCommandError(error)
      };
    } finally {
      if (hydrated) {
        this.activeExecutionDirectories.delete(hydrated.executionDirectory);
        if (this.reuseWorkspaceDirectories && cacheReusable) {
          const executionDirectory = hydrated.executionDirectory;
          const accessedAt = new Date();
          await utimes(executionDirectory, accessedAt, accessedAt).catch(async () => {
            await rm(executionDirectory, { recursive: true, force: true });
          });
        } else {
          await rm(hydrated.executionDirectory, { recursive: true, force: true });
        }
      }
    }
  }

  private async requireWorkspace(command: WorkspaceCommand): Promise<ExecutionWorkspace> {
    const workspace = await this.store.executionWorkspaces.getExecutionWorkspace({
      clientInstanceId: command.clientInstanceId,
      workspaceId: command.workspaceId
    });
    if (!workspace) {
      throw new WorkspaceRunnerFailure(
        "WORKSPACE_NOT_FOUND",
        "Execution workspace is not available",
        "runner_error"
      );
    }
    return workspace;
  }

  private async hydrateWorkspace(
    workspace: ExecutionWorkspace,
    command: WorkspaceCommand
  ): Promise<HydratedWorkspace> {
    return hydrateWorkspace(
      {
        store: this.store,
        byteStore: this.byteStore,
        workerId: this.workerId,
        tempRootDirectory: this.tempRootDirectory,
        maxPathLength: this.maxPathLength,
        reuseWorkspaceDirectories: this.reuseWorkspaceDirectories,
        ensureStandardWorkspaceDirectories: this.ensureStandardWorkspaceDirectories.bind(this),
        scanWorkspaceFiles: this.scanWorkspaceFiles.bind(this)
      },
      workspace,
      command
    );
  }

  private async ensureStandardWorkspaceDirectories(workspaceDirectory: string): Promise<void> {
    return ensureStandardWorkspaceDirectories(workspaceDirectory);
  }

  private async runProcess(
    command: WorkspaceCommand,
    workspaceDirectory: string,
    tempDirectory: string,
    signal?: AbortSignal
  ): Promise<ProcessResult> {
    const normalizedCwd = command.cwd
      ? normalizeWorkspaceDirectory(command.cwd, { maxPathLength: this.maxPathLength })
      : { status: "success" as const, value: "." };
    if (normalizedCwd.status === "failed") {
      throw new WorkspaceRunnerFailure(
        "WORKSPACE_CWD_REJECTED",
        normalizedCwd.message,
        "runner_error",
        normalizedCwd.details
      );
    }
    const cwd = resolveWorkspaceFilesystemPath(workspaceDirectory, normalizedCwd.value, {
      maxPathLength: this.maxPathLength
    });
    if (cwd.status === "failed") {
      throw new WorkspaceRunnerFailure(
        "WORKSPACE_CWD_REJECTED",
        cwd.message,
        "runner_error",
        cwd.details
      );
    }
    return this.processExecutor.execute({
      command,
      workspaceDirectory,
      workspaceCwd: normalizedCwd.value,
      cwd: cwd.value,
      tempDirectory,
      env: {
        HOME: workspaceDirectory,
        PATH: readToolExecutionEnv().path,
        TMPDIR: tempDirectory,
        WORKSPACE_DIR: workspaceDirectory
      },
      signal
    });
  }

  private async scanWorkspaceFiles(
    workspaceDirectory: string,
    command: WorkspaceCommand
  ): Promise<ScannedWorkspaceFile[]> {
    return scanWorkspaceFiles(this.maxPathLength, workspaceDirectory, command);
  }

  private async syncChangedFiles(
    workspace: ExecutionWorkspace,
    command: WorkspaceCommand,
    baselineFiles: Map<string, WorkspaceFile>,
    scannedFiles: ScannedWorkspaceFile[]
  ): Promise<SyncedWorkspaceFile[]> {
    const changedFiles: SyncedWorkspaceFile[] = [];
    const scannedPaths = new Set(scannedFiles.map((file) => file.path));
    for (const scanned of scannedFiles) {
      const baseline = baselineFiles.get(scanned.path);
      if (baseline?.checksum === scanned.checksum && baseline.byteSize === scanned.byteSize) {
        continue;
      }
      const stored = await putWorkspaceFile(this.byteStore, {
        clientInstanceId: command.clientInstanceId,
        conversationId: workspace.conversationId,
        workspaceId: workspace.id,
        commandId: command.id,
        path: scanned.path,
        bytes: scanned.bytes,
        checksum: scanned.checksum,
        mimeType: scanned.mimeType
      });
      const file = await upsertStoredWorkspaceFile(
        this.store.executionWorkspaces,
        this.byteStore,
        this.telemetry,
        {
          clientInstanceId: command.clientInstanceId,
          workspaceId: workspace.id,
          path: scanned.path,
          objectKey: stored.objectKey,
          byteSize: scanned.byteSize,
          checksum: scanned.checksum,
          mimeType: scanned.mimeType,
          metadata: {
            ...baseline?.metadata,
            source: "workspace.exec"
          },
          lastCommandId: command.id,
          updatedAt: this.now()
        }
      );
      changedFiles.push({
        file,
        output: {
          path: scanned.path,
          byteSize: scanned.byteSize,
          checksum: scanned.checksum,
          objectKey: stored.objectKey,
          mimeType: scanned.mimeType
        }
      });
    }
    for (const [path, baseline] of baselineFiles) {
      if (scannedPaths.has(path)) {
        continue;
      }
      await this.store.executionWorkspaces.deleteWorkspaceFile({
        clientInstanceId: command.clientInstanceId,
        workspaceId: workspace.id,
        path,
        lastCommandId: command.id,
        deletedAt: this.now()
      });
    }
    return changedFiles;
  }

  private async promoteExpectedOutputs(
    command: WorkspaceCommand,
    changedFiles: SyncedWorkspaceFile[],
    workspaceDirectory: string
  ): Promise<WorkspaceCommandPromotedArtifact[]> {
    const promotedArtifacts: WorkspaceCommandPromotedArtifact[] = [];
    for (const expected of command.expectedOutputs) {
      if (!expected.promote) {
        continue;
      }
      const changed = changedFiles.find((file) => file.output.path === expected.path);
      if (!changed?.output.objectKey) {
        continue;
      }
      const kind = expected.kind ?? "workspace.file";
      const sourcePath = resolveWorkspaceFilesystemPath(workspaceDirectory, changed.output.path, {
        maxPathLength: this.maxPathLength
      });
      if (sourcePath.status === "failed") {
        continue;
      }
      const artifact = await promoteWorkspaceFile(this.store, {
        file: changed.file,
        kind,
        filename: basename(changed.output.path),
        mimeType: changed.output.mimeType ?? "application/octet-stream",
        commandId: command.id,
        now: this.now
      });
      changed.output.artifactId = artifact.id;
      promotedArtifacts.push({
        artifactId: artifact.id,
        path: changed.output.path,
        kind: artifact.kind,
        mimeType: artifact.mimeType
      });
    }
    return promotedArtifacts;
  }

  private processError(
    command: WorkspaceCommand,
    processResult: ProcessResult
  ): WorkspaceCommandError | undefined {
    if (processResult.cancelled) {
      return workspaceCommandError(
        "WORKSPACE_COMMAND_CANCELLED",
        processResult.cancellationReason ?? "Workspace command was cancelled",
        "cancelled"
      );
    }
    if (processResult.spawnError) {
      return workspaceCommandError(
        "WORKSPACE_COMMAND_SPAWN_FAILED",
        processResult.spawnError.message,
        "runner_error"
      );
    }
    if (processResult.timeoutKind === "wall") {
      return workspaceCommandError(
        "WORKSPACE_COMMAND_TIMEOUT",
        "Workspace command exceeded the configured timeout",
        "timeout",
        {
          timeoutSeconds: command.limits.timeoutSeconds
        }
      );
    }
    if (processResult.timeoutKind === "idle") {
      return workspaceCommandError(
        "WORKSPACE_COMMAND_IDLE_TIMEOUT",
        "Workspace command exceeded the configured no-output timeout",
        "timeout",
        {
          idleTimeoutSeconds: command.limits.idleTimeoutSeconds ?? 0
        }
      );
    }
    if (processResult.exitCode !== 0) {
      return workspaceCommandError(
        "WORKSPACE_COMMAND_EXIT_NONZERO",
        `Workspace command exited with code ${processResult.exitCode}`,
        "runner_error",
        {
          exitCode: processResult.exitCode
        }
      );
    }
    return undefined;
  }
}

function commandOutputFromProcess(
  processResult: ProcessResult,
  changedFiles: WorkspaceCommandChangedFile[],
  promotedArtifacts: WorkspaceCommandPromotedArtifact[]
): WorkspaceCommandOutput {
  return {
    exitCode: processResult.exitCode,
    stdoutPreview: processResult.stdoutPreview,
    stderrPreview: processResult.stderrPreview,
    durationMs: processResult.durationMs,
    changedFiles,
    promotedArtifacts,
    truncated: processResult.truncated
  };
}

function terminalCommandAuditMetadata(command: WorkspaceCommand): JsonObject {
  return {
    exitCode: command.output?.exitCode ?? null,
    durationMs: command.output?.durationMs ?? null,
    changedFileCount: command.output?.changedFiles.length ?? 0,
    promotedArtifactCount: command.output?.promotedArtifacts.length ?? 0,
    stdoutTruncated: command.output?.truncated.stdout ?? false,
    stderrTruncated: command.output?.truncated.stderr ?? false,
    ...(command.error
      ? {
          errorCode: command.error.code,
          errorCategory: command.error.category
        }
      : {})
  };
}
export { STANDARD_WORKSPACE_DIRECTORIES } from "./workspace-command-files";
