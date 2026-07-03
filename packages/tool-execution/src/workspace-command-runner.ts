import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  type ClientInstanceId,
  type ExecutionWorkspace,
  type AuditRecorder,
  type JsonObject,
  type PlatformStore,
  type WorkspaceCommand,
  type WorkspaceCommandChangedFile,
  type WorkspaceCommandError,
  type WorkspaceCommandFailureCategory,
  type WorkspaceCommandOutput,
  type WorkspaceCommandPromotedArtifact,
  type WorkspaceFile
} from "@vivd-catalyst/core";
import { enqueueArtifactPreviewJobForPromotedArtifact } from "./artifact-preview-jobs";
import type { WorkspaceCommandResultSource } from "./workspace-tools";
import type { WorkspaceFileByteStore } from "./workspace-file-bytes";
import {
  normalizeWorkspaceDirectory,
  normalizeWorkspaceFilePath,
  resolveWorkspaceFilesystemPath
} from "./workspace-paths";
import {
  DEFAULT_WORKSPACE_COMMAND_PATH,
  LocalWorkspaceCommandProcessExecutor,
  type ProcessResult,
  type WorkspaceCommandProcessExecutor
} from "./workspace-command-executor";
import {
  emitWorkspaceCommandTelemetry,
  recordWorkspaceCommandLifecycleAudit,
  terminalWorkspaceCommandAuditType,
  workspaceCommandTelemetryEvent,
  type WorkspaceCommandTelemetry
} from "./workspace-command-telemetry";
import {
  createWorkspaceArtifactPreviewMetadata,
  type WorkspaceArtifactPreviewGenerator
} from "./workspace-artifact-previews";

const DEFAULT_MAX_PATH_LENGTH = 512;
const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_WORKSPACE_BYTES = 100 * 1024 * 1024;

export type WorkspaceCommandRunnerStore = Pick<
  PlatformStore,
  | "getExecutionWorkspace"
  | "listWorkspaceFiles"
  | "upsertWorkspaceFile"
  | "deleteWorkspaceFile"
  | "claimNextWorkspaceCommand"
  | "completeWorkspaceCommand"
  | "failWorkspaceCommand"
  | "cancelClaimedWorkspaceCommand"
  | "createManagedArtifact"
  | "enqueueArtifactPreviewJob"
>;

export interface LocalWorkspaceCommandRunnerOptions {
  store: WorkspaceCommandRunnerStore;
  byteStore: WorkspaceFileByteStore;
  workerId?: string;
  tempRootDirectory?: string;
  leaseDurationMs?: number;
  maxPathLength?: number;
  shellPath?: string;
  processExecutor?: WorkspaceCommandProcessExecutor;
  artifactPreviewGenerator?: WorkspaceArtifactPreviewGenerator;
  auditRecorder?: AuditRecorder;
  telemetry?: WorkspaceCommandTelemetry;
  now?: () => string;
}

export interface RunNextWorkspaceCommandInput {
  clientInstanceId: ClientInstanceId;
}

interface CommandExecutionResult {
  output?: WorkspaceCommandOutput;
  error?: WorkspaceCommandError;
  cancelled?: boolean;
}

interface HydratedWorkspace {
  executionDirectory: string;
  workspaceDirectory: string;
  baselineFiles: Map<string, WorkspaceFile>;
}

interface ScannedWorkspaceFile {
  path: string;
  bytes: Uint8Array;
  byteSize: number;
  checksum: string;
  mimeType?: string;
}

export interface RunClaimedWorkspaceCommandOptions {
  signal?: AbortSignal;
}

export class LocalWorkspaceCommandRunner {
  private readonly store: WorkspaceCommandRunnerStore;
  private readonly byteStore: WorkspaceFileByteStore;
  private readonly workerId: string;
  private readonly tempRootDirectory: string;
  private readonly leaseDurationMs: number;
  private readonly maxPathLength: number;
  private readonly processExecutor: WorkspaceCommandProcessExecutor;
  private readonly artifactPreviewGenerator?: WorkspaceArtifactPreviewGenerator;
  private readonly auditRecorder?: AuditRecorder;
  private readonly telemetry?: WorkspaceCommandTelemetry;
  private readonly now: () => string;

  constructor(options: LocalWorkspaceCommandRunnerOptions) {
    this.store = options.store;
    this.byteStore = options.byteStore;
    this.workerId = options.workerId ?? `local-workspace-runner-${randomUUID()}`;
    this.tempRootDirectory = options.tempRootDirectory ?? tmpdir();
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.maxPathLength = options.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH;
    this.processExecutor =
      options.processExecutor ?? new LocalWorkspaceCommandProcessExecutor({ shellPath: options.shellPath });
    this.artifactPreviewGenerator = options.artifactPreviewGenerator;
    this.auditRecorder = options.auditRecorder;
    this.telemetry = options.telemetry;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runNextCommand(input: RunNextWorkspaceCommandInput): Promise<WorkspaceCommand | undefined> {
    const now = this.now();
    const claimed = await this.store.claimNextWorkspaceCommand({
      clientInstanceId: input.clientInstanceId,
      workerId: this.workerId,
      leaseToken: randomUUID(),
      now,
      leaseExpiresAt: addMilliseconds(now, this.leaseDurationMs)
    });
    if (!claimed) {
      return undefined;
    }
    await this.recordRunningCommand(claimed);
    return this.runClaimedCommand(claimed);
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
    const completedAt = this.now();
    let terminal: WorkspaceCommand;
    if (result.cancelled) {
      terminal = await this.store.cancelClaimedWorkspaceCommand({
        clientInstanceId: command.clientInstanceId,
        commandId: command.id,
        leaseToken,
        reason: result.error?.message,
        output: result.output,
        cancelledAt: completedAt
      });
      await this.recordTerminalCommand(terminal);
      return terminal;
    }
    if (result.error) {
      terminal = await this.store.failWorkspaceCommand({
        clientInstanceId: command.clientInstanceId,
        commandId: command.id,
        leaseToken,
        error: result.error,
        output: result.output,
        failedAt: completedAt
      });
      await this.recordTerminalCommand(terminal);
      return terminal;
    }
    if (!result.output) {
      terminal = await this.store.failWorkspaceCommand({
        clientInstanceId: command.clientInstanceId,
        commandId: command.id,
        leaseToken,
        error: workspaceCommandError(
          "WORKSPACE_COMMAND_RUNNER_ERROR",
          "Workspace command runner did not produce an output",
          "internal_error"
        ),
        failedAt: completedAt
      });
      await this.recordTerminalCommand(terminal);
      return terminal;
    }
    terminal = await this.store.completeWorkspaceCommand({
      clientInstanceId: command.clientInstanceId,
      commandId: command.id,
      leaseToken,
      output: result.output,
      completedAt
    });
    await this.recordTerminalCommand(terminal);
    return terminal;
  }

  async cleanupOrphanedTempState(input: {
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

  private async recordRunningCommand(command: WorkspaceCommand): Promise<void> {
    await recordWorkspaceCommandLifecycleAudit({
      auditRecorder: this.auditRecorder,
      type: "workspace_command.running",
      status: "success",
      command,
      metadata: {
        workerId: this.workerId,
        leaseExpiresAt: command.leaseExpiresAt ?? null
      }
    });
    await emitWorkspaceCommandTelemetry(
      this.telemetry,
      workspaceCommandTelemetryEvent("running", command, {
        workerId: this.workerId
      })
    );
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
    try {
      const workspace = await this.requireWorkspace(command);
      hydrated = await this.hydrateWorkspace(workspace, command);
      processResult = await this.runProcess(
        command,
        hydrated.workspaceDirectory,
        join(hydrated.executionDirectory, "tmp"),
        options.signal
      );
      const scannedFiles = await this.scanWorkspaceFiles(hydrated.workspaceDirectory, command);
      changedFiles = await this.syncChangedFiles(
        workspace,
        command,
        hydrated.baselineFiles,
        scannedFiles
      );
      promotedArtifacts = await this.promoteExpectedOutputs(
        workspace,
        command,
        changedFiles,
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
        await rm(hydrated.executionDirectory, { recursive: true, force: true });
      }
    }
  }

  private async requireWorkspace(command: WorkspaceCommand): Promise<ExecutionWorkspace> {
    const workspace = await this.store.getExecutionWorkspace({
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
    await mkdir(this.tempRootDirectory, { recursive: true });
    const executionDirectory = await mkdtemp(join(this.tempRootDirectory, "catalyst-workspace-"));
    const workspaceDirectory = join(executionDirectory, "workspace");
    await mkdir(workspaceDirectory, { recursive: true });
    const files = await this.store.listWorkspaceFiles({
      clientInstanceId: command.clientInstanceId,
      workspaceId: workspace.id
    });
    const baselineFiles = new Map<string, WorkspaceFile>();
    for (const file of files) {
      const normalized = normalizeWorkspaceFilePath(file.path, {
        maxPathLength: this.maxPathLength
      });
      if (normalized.status === "failed") {
        throw new WorkspaceRunnerFailure(
          "WORKSPACE_FILE_PATH_REJECTED",
          normalized.message,
          "runner_error",
          normalized.details
        );
      }
      const target = resolveWorkspaceFilesystemPath(workspaceDirectory, normalized.value, {
        maxPathLength: this.maxPathLength
      });
      if (target.status === "failed") {
        throw new WorkspaceRunnerFailure(
          "WORKSPACE_FILE_PATH_REJECTED",
          target.message,
          "runner_error",
          target.details
        );
      }
      const bytes = await this.byteStore.getObject(file.objectKey);
      await mkdir(dirname(target.value), { recursive: true });
      await writeFile(target.value, bytes);
      baselineFiles.set(normalized.value, {
        ...file,
        path: normalized.value
      });
    }
    return {
      executionDirectory,
      workspaceDirectory,
      baselineFiles
    };
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
        PATH: process.env.PATH ?? DEFAULT_WORKSPACE_COMMAND_PATH,
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
    const scanned: ScannedWorkspaceFile[] = [];
    let totalBytes = 0;
    const scanDirectory = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = join(directory, entry.name);
        const workspacePath = relative(workspaceDirectory, absolutePath).split("\\").join("/");
        if (entry.isSymbolicLink()) {
          throw new WorkspaceRunnerFailure(
            "WORKSPACE_SYMLINK_REJECTED",
            "Workspace files must not be symbolic links",
            "runner_error",
            { path: workspacePath }
          );
        }
        if (entry.isDirectory()) {
          await scanDirectory(absolutePath);
          continue;
        }
        if (!entry.isFile()) {
          throw new WorkspaceRunnerFailure(
            "WORKSPACE_FILE_TYPE_REJECTED",
            "Workspace contains an unsupported file type",
            "runner_error",
            { path: workspacePath }
          );
        }
        const normalized = normalizeWorkspaceFilePath(workspacePath, {
          maxPathLength: this.maxPathLength
        });
        if (normalized.status === "failed") {
          throw new WorkspaceRunnerFailure(
            "WORKSPACE_FILE_PATH_REJECTED",
            normalized.message,
            "runner_error",
            normalized.details
          );
        }
        const stats = await lstat(absolutePath);
        if (!stats.isFile()) {
          throw new WorkspaceRunnerFailure(
            "WORKSPACE_FILE_TYPE_REJECTED",
            "Workspace contains an unsupported file type",
            "runner_error",
            { path: normalized.value }
          );
        }
        totalBytes += stats.size;
        if (totalBytes > (command.limits.maxWorkspaceBytes ?? DEFAULT_WORKSPACE_BYTES)) {
          throw new WorkspaceRunnerFailure(
            "WORKSPACE_SIZE_LIMIT_EXCEEDED",
            "Workspace size limit exceeded",
            "runner_error",
            {
              path: normalized.value,
              totalBytes,
              maxWorkspaceBytes: command.limits.maxWorkspaceBytes ?? DEFAULT_WORKSPACE_BYTES
            }
          );
        }
        const bytes = await readFile(absolutePath);
        scanned.push({
          path: normalized.value,
          bytes,
          byteSize: bytes.byteLength,
          checksum: createWorkspaceChecksum(bytes),
          mimeType: inferWorkspaceMimeType(normalized.value)
        });
      }
    };
    await scanDirectory(workspaceDirectory);
    return scanned.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async syncChangedFiles(
    workspace: ExecutionWorkspace,
    command: WorkspaceCommand,
    baselineFiles: Map<string, WorkspaceFile>,
    scannedFiles: ScannedWorkspaceFile[]
  ): Promise<WorkspaceCommandChangedFile[]> {
    const changedFiles: WorkspaceCommandChangedFile[] = [];
    const scannedPaths = new Set(scannedFiles.map((file) => file.path));
    for (const scanned of scannedFiles) {
      const baseline = baselineFiles.get(scanned.path);
      if (baseline?.checksum === scanned.checksum && baseline.byteSize === scanned.byteSize) {
        continue;
      }
      const stored = await this.byteStore.putWorkspaceFile({
        clientInstanceId: command.clientInstanceId,
        conversationId: workspace.conversationId,
        workspaceId: workspace.id,
        commandId: command.id,
        path: scanned.path,
        bytes: scanned.bytes,
        checksum: scanned.checksum,
        mimeType: scanned.mimeType
      });
      await this.store.upsertWorkspaceFile({
        clientInstanceId: command.clientInstanceId,
        workspaceId: workspace.id,
        path: scanned.path,
        objectKey: stored.objectKey,
        byteSize: scanned.byteSize,
        checksum: scanned.checksum,
        mimeType: scanned.mimeType,
        metadata: {
          source: "workspace.exec"
        },
        lastCommandId: command.id,
        updatedAt: this.now()
      });
      changedFiles.push({
        path: scanned.path,
        byteSize: scanned.byteSize,
        checksum: scanned.checksum,
        objectKey: stored.objectKey,
        mimeType: scanned.mimeType
      });
    }
    for (const [path, baseline] of baselineFiles) {
      if (scannedPaths.has(path)) {
        continue;
      }
      const deleted = await this.store.deleteWorkspaceFile({
        clientInstanceId: command.clientInstanceId,
        workspaceId: workspace.id,
        path,
        lastCommandId: command.id,
        deletedAt: this.now()
      });
      if (deleted && this.byteStore.deleteObject) {
        await this.byteStore.deleteObject(baseline.objectKey);
      }
    }
    return changedFiles;
  }

  private async promoteExpectedOutputs(
    workspace: ExecutionWorkspace,
    command: WorkspaceCommand,
    changedFiles: WorkspaceCommandChangedFile[],
    workspaceDirectory: string
  ): Promise<WorkspaceCommandPromotedArtifact[]> {
    const promotedArtifacts: WorkspaceCommandPromotedArtifact[] = [];
    for (const expected of command.expectedOutputs) {
      if (!expected.promote) {
        continue;
      }
      const changed = changedFiles.find((file) => file.path === expected.path);
      if (!changed?.objectKey) {
        continue;
      }
      const kind = expected.kind ?? "workspace.file";
      const sourcePath = resolveWorkspaceFilesystemPath(workspaceDirectory, changed.path, {
        maxPathLength: this.maxPathLength
      });
      if (sourcePath.status === "failed") {
        continue;
      }
      const previewMetadata = await createWorkspaceArtifactPreviewMetadata({
        artifactKind: kind,
        byteStore: this.byteStore,
        clientInstanceId: command.clientInstanceId,
        commandId: command.id,
        conversationId: workspace.conversationId,
        filename: basename(changed.path),
        sourcePath: sourcePath.value,
        store: this.store,
        workspaceId: workspace.id,
        workspacePath: changed.path,
        ...(changed.mimeType ? { artifactMimeType: changed.mimeType } : {}),
        ...(this.artifactPreviewGenerator ? { generator: this.artifactPreviewGenerator } : {})
      });
      const artifact = await this.store.createManagedArtifact({
        clientInstanceId: command.clientInstanceId,
        conversationId: workspace.conversationId,
        kind,
        objectKey: changed.objectKey,
        filename: basename(changed.path),
        mimeType: changed.mimeType ?? "application/octet-stream",
        byteSize: changed.byteSize,
        checksum: changed.checksum,
        metadata: {
          source: "execution_workspace",
          workspaceId: workspace.id,
          workspacePath: changed.path,
          commandId: command.id,
          ...(previewMetadata ? (previewMetadata as unknown as JsonObject) : {})
        }
      });
      await enqueueArtifactPreviewJobForPromotedArtifact(this.store, artifact);
      changed.artifactId = artifact.id;
      await this.store.upsertWorkspaceFile({
        clientInstanceId: command.clientInstanceId,
        workspaceId: workspace.id,
        path: changed.path,
        objectKey: changed.objectKey,
        byteSize: changed.byteSize,
        checksum: changed.checksum,
        mimeType: changed.mimeType,
        metadata: {
          source: "workspace.exec",
          promotedArtifacts: [
            {
              artifactId: artifact.id,
              kind: artifact.kind,
              promotedAt: artifact.createdAt
            }
          ]
        },
        lastCommandId: command.id,
        updatedAt: this.now()
      });
      promotedArtifacts.push({
        artifactId: artifact.id,
        path: changed.path,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        ...(previewMetadata ? { metadata: previewMetadata } : {})
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

export class LocalWorkspaceCommandResultSource implements WorkspaceCommandResultSource {
  constructor(private readonly runner: LocalWorkspaceCommandRunner) {}

  async resolveWorkspaceCommand(input: { command: WorkspaceCommand }): Promise<WorkspaceCommand> {
    if (input.command.status !== "queued") {
      return input.command;
    }
    const resolved = await this.runner.runNextCommand({
      clientInstanceId: input.command.clientInstanceId
    });
    return resolved?.id === input.command.id ? resolved : input.command;
  }
}

class WorkspaceRunnerFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly category: WorkspaceCommandFailureCategory,
    readonly details?: JsonObject
  ) {
    super(message);
  }
}

function toWorkspaceCommandError(error: unknown): WorkspaceCommandError {
  if (error instanceof WorkspaceRunnerFailure) {
    return workspaceCommandError(error.code, error.message, error.category, error.details);
  }
  return workspaceCommandError(
    "WORKSPACE_COMMAND_RUNNER_ERROR",
    error instanceof Error ? error.message : "Workspace command runner failed",
    "internal_error"
  );
}

function workspaceCommandError(
  code: string,
  message: string,
  category: WorkspaceCommandFailureCategory,
  details?: JsonObject
): WorkspaceCommandError {
  return {
    code,
    message,
    category,
    details
  };
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

function createWorkspaceChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inferWorkspaceMimeType(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv")) {
    return "text/plain";
  }
  if (lower.endsWith(".json")) {
    return "application/json";
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "application/javascript";
  }
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) {
    return "application/typescript";
  }
  if (lower.endsWith(".html")) {
    return "text/html";
  }
  if (lower.endsWith(".xml")) {
    return "application/xml";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  return undefined;
}

function addMilliseconds(isoDate: string, milliseconds: number): string {
  return new Date(new Date(isoDate).getTime() + milliseconds).toISOString();
}
