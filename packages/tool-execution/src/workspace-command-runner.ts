import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  type ClientInstanceId,
  type ExecutionWorkspace,
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
import type { WorkspaceCommandResultSource } from "./workspace-tools";
import type { WorkspaceFileByteStore } from "./workspace-file-bytes";
import {
  normalizeWorkspaceDirectory,
  normalizeWorkspaceFilePath,
  resolveWorkspaceFilesystemPath
} from "./workspace-paths";

const DEFAULT_MAX_PATH_LENGTH = 512;
const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_STDIO_BYTES = 64 * 1024;
const DEFAULT_WORKSPACE_BYTES = 100 * 1024 * 1024;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type WorkspaceCommandRunnerStore = Pick<
  PlatformStore,
  | "getExecutionWorkspace"
  | "listWorkspaceFiles"
  | "upsertWorkspaceFile"
  | "claimNextWorkspaceCommand"
  | "completeWorkspaceCommand"
  | "failWorkspaceCommand"
  | "createManagedArtifact"
>;

export interface LocalWorkspaceCommandRunnerOptions {
  store: WorkspaceCommandRunnerStore;
  byteStore: WorkspaceFileByteStore;
  workerId?: string;
  tempRootDirectory?: string;
  leaseDurationMs?: number;
  maxPathLength?: number;
  shellPath?: string;
  now?: () => string;
}

export interface RunNextWorkspaceCommandInput {
  clientInstanceId: ClientInstanceId;
}

interface CommandExecutionResult {
  output?: WorkspaceCommandOutput;
  error?: WorkspaceCommandError;
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

interface ProcessResult {
  exitCode: number;
  stdoutPreview: string;
  stderrPreview: string;
  truncated: {
    stdout: boolean;
    stderr: boolean;
  };
  durationMs: number;
  timeoutKind?: "wall" | "idle";
  spawnError?: Error;
}

export class LocalWorkspaceCommandRunner {
  private readonly store: WorkspaceCommandRunnerStore;
  private readonly byteStore: WorkspaceFileByteStore;
  private readonly workerId: string;
  private readonly tempRootDirectory: string;
  private readonly leaseDurationMs: number;
  private readonly maxPathLength: number;
  private readonly shellPath: string;
  private readonly now: () => string;

  constructor(options: LocalWorkspaceCommandRunnerOptions) {
    this.store = options.store;
    this.byteStore = options.byteStore;
    this.workerId = options.workerId ?? `local-workspace-runner-${randomUUID()}`;
    this.tempRootDirectory = options.tempRootDirectory ?? tmpdir();
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.maxPathLength = options.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH;
    this.shellPath = options.shellPath ?? "/bin/sh";
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
    return this.runClaimedCommand(claimed);
  }

  async runClaimedCommand(command: WorkspaceCommand): Promise<WorkspaceCommand> {
    const leaseToken = command.leaseToken;
    if (!leaseToken) {
      throw new Error("Workspace command must be claimed before local execution");
    }

    const result = await this.executeCommand(command);
    const completedAt = this.now();
    if (result.error) {
      return this.store.failWorkspaceCommand({
        clientInstanceId: command.clientInstanceId,
        commandId: command.id,
        leaseToken,
        error: result.error,
        output: result.output,
        failedAt: completedAt
      });
    }
    if (!result.output) {
      return this.store.failWorkspaceCommand({
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
    }
    return this.store.completeWorkspaceCommand({
      clientInstanceId: command.clientInstanceId,
      commandId: command.id,
      leaseToken,
      output: result.output,
      completedAt
    });
  }

  private async executeCommand(command: WorkspaceCommand): Promise<CommandExecutionResult> {
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
        join(hydrated.executionDirectory, "tmp")
      );
      const scannedFiles = await this.scanWorkspaceFiles(hydrated.workspaceDirectory, command);
      changedFiles = await this.syncChangedFiles(
        workspace,
        command,
        hydrated.baselineFiles,
        scannedFiles
      );
      promotedArtifacts = await this.promoteExpectedOutputs(workspace, command, changedFiles);
      const output = commandOutputFromProcess(processResult, changedFiles, promotedArtifacts);
      const processError = this.processError(command, processResult);
      return {
        output,
        error: processError
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
    tempDirectory: string
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
    const stdout = new BoundedOutput(command.limits.maxStdoutBytes ?? DEFAULT_STDIO_BYTES);
    const stderr = new BoundedOutput(command.limits.maxStderrBytes ?? DEFAULT_STDIO_BYTES);
    await mkdir(tempDirectory, { recursive: true });
    const startedAt = Date.now();
    return new Promise((resolvePromise) => {
      let settled = false;
      let timeoutKind: ProcessResult["timeoutKind"];
      let spawnError: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const child = spawn(this.shellPath, ["-c", command.command], {
        cwd: cwd.value,
        detached: true,
        env: {
          HOME: workspaceDirectory,
          PATH: process.env.PATH ?? DEFAULT_PATH,
          TMPDIR: tempDirectory,
          WORKSPACE_DIR: workspaceDirectory
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const finish = (exitCode: number, signal?: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(wallTimer);
        clearTimeout(idleTimer);
        clearTimeout(killTimer);
        resolvePromise({
          exitCode: timeoutKind ? 124 : exitCodeFromProcess(exitCode, signal),
          stdoutPreview: stdout.text(),
          stderrPreview: stderr.text(),
          truncated: {
            stdout: stdout.truncated,
            stderr: stderr.truncated
          },
          durationMs: Date.now() - startedAt,
          timeoutKind,
          spawnError
        });
      };
      const terminate = (kind: NonNullable<ProcessResult["timeoutKind"]>) => {
        if (settled || timeoutKind) {
          return;
        }
        timeoutKind = kind;
        terminateProcessGroup(child, "SIGTERM");
        killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 500);
      };
      const resetIdleTimer = () => {
        if (!command.limits.idleTimeoutSeconds || settled || timeoutKind) {
          return;
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => terminate("idle"),
          command.limits.idleTimeoutSeconds * 1000
        );
      };
      const wallTimer = setTimeout(
        () => terminate("wall"),
        command.limits.timeoutSeconds * 1000
      );
      let idleTimer: NodeJS.Timeout | undefined;
      resetIdleTimer();
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.append(chunk);
        resetIdleTimer();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.append(chunk);
        resetIdleTimer();
      });
      child.on("error", (error) => {
        spawnError = error;
        finish(127);
      });
      child.on("close", (code, signal) => {
        finish(code ?? 1, signal);
      });
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
    return changedFiles;
  }

  private async promoteExpectedOutputs(
    workspace: ExecutionWorkspace,
    command: WorkspaceCommand,
    changedFiles: WorkspaceCommandChangedFile[]
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
          commandId: command.id
        }
      });
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
        mimeType: artifact.mimeType
      });
    }
    return promotedArtifacts;
  }

  private processError(
    command: WorkspaceCommand,
    processResult: ProcessResult
  ): WorkspaceCommandError | undefined {
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

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private byteLength = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    const remaining = this.maxBytes - this.byteLength;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      this.chunks.push(kept);
      this.byteLength += kept.byteLength;
    }
    if (chunk.byteLength > remaining) {
      this.truncated = true;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks, this.byteLength).toString("utf8");
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

function terminateProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals
): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function exitCodeFromProcess(code: number, signal?: NodeJS.Signals | null): number {
  if (code !== null && code !== undefined) {
    return code;
  }
  return signal ? 128 : 1;
}

function addMilliseconds(isoDate: string, milliseconds: number): string {
  return new Date(new Date(isoDate).getTime() + milliseconds).toISOString();
}
