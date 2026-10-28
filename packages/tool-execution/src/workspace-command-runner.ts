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
  type SkillFolderReader,
  type WorkspaceFile
} from "@work-shape/catalyst-core";
import type { ProjectCommandFileChange, ProjectCommandFolderPort } from "@work-shape/catalyst-core";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readToolExecutionEnv } from "./env";
import { ProjectFolderMounts, type PreparedProjectFolder } from "./project-folder-mount";
import {
  removeTree,
  SKILL_FOLDER_CACHE_DIRECTORY,
  SkillFolderCache,
  skillMountFailure,
  type SkillFolderLease
} from "./skill-folder-cache";
import { promoteWorkspaceFile } from "./workspace-artifact-promotion";
import {
  toWorkspaceCommandError,
  workspaceCommandError,
  WorkspaceRunnerFailure
} from "./workspace-command-errors";
import {
  LocalWorkspaceCommandProcessExecutor,
  type ProcessResult,
  type SandboxSkillFolder,
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
  /**
   * Reads the folders of the skills a command recorded. Without it a command that mounts a
   * skill fails and runs nothing; one without skills runs as before.
   */
  skillFolders?: SkillFolderReader;
  projectFolders?: ProjectCommandFolderPort;
  now?: () => string;
}

/**
 * Where a sandbox that runs commands as processes of its worker finds copies of the skill
 * folders, beside the workspace: `<execution directory>/skills/<name>`. For development only:
 * they are writable, and a command reaches them as `$WORKSPACE_DIR/../skills/<name>`.
 */
export const LOCAL_SKILL_FOLDERS_DIRECTORY = "skills";

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
  private readonly skillFolderCache?: SkillFolderCache;
  private readonly projectFolders?: ProjectFolderMounts;

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
    this.projectFolders = options.projectFolders
      ? new ProjectFolderMounts({
          rootDirectory: this.tempRootDirectory,
          port: options.projectFolders
        })
      : undefined;
    this.skillFolderCache = options.skillFolders
      ? new SkillFolderCache({
          rootDirectory: join(this.tempRootDirectory, SKILL_FOLDER_CACHE_DIRECTORY),
          reader: options.skillFolders
        })
      : undefined;
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
    // Skill folders go with the same time unused as the workspaces.
    const skills = (await this.skillFolderCache?.evictIdle(input)) ?? {
      removedCount: 0,
      failedCount: 0
    };
    const projects = await this.projectFolders?.evictIdle(input);
    let removedCount = skills.removedCount + (projects?.removedCount ?? 0);
    let failedCount = skills.failedCount + (projects?.failedCount ?? 0);
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
    let skillLease: SkillFolderLease | undefined;
    let projectMount: PreparedProjectFolder | undefined;
    let projectDirectory: string | undefined;
    const projectFileChanges: ProjectCommandFileChange[] = [];
    try {
      const workspace = await this.requireWorkspace(command);
      hydrated = await this.hydrateWorkspace(workspace, command);
      this.activeExecutionDirectories.add(hydrated.executionDirectory);
      // A fresh bind source path per command also avoids a Docker host retaining the inode
      // of a removed and recreated directory when the conversation directory is reused.
      projectDirectory = this.processExecutor.mountsProjectFolder
        ? join(hydrated.executionDirectory, `project-${randomUUID()}`)
        : join(hydrated.workspaceDirectory, "project");
      projectMount = await this.projectFolders?.prepare(command, projectDirectory);
      if (projectMount && this.processExecutor.mountsProjectFolder) {
        await mkdir(join(hydrated.workspaceDirectory, "project"), { recursive: true });
      }
      skillLease = await this.acquireSkillFolders(command);
      const skillFolders = await this.placeSkillFolders(
        skillLease?.folders ?? [],
        hydrated.executionDirectory
      );
      processResult = await this.runProcess(
        command,
        hydrated.workspaceDirectory,
        join(hydrated.executionDirectory, "tmp"),
        options.signal,
        skillFolders,
        projectMount && this.processExecutor.mountsProjectFolder
          ? projectMount.directory
          : undefined
      );
      if (projectMount) {
        await this.projectFolders?.sync(command, projectMount, projectFileChanges);
      }
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
      const output = commandOutputFromProcess(
        processResult,
        changedFiles,
        promotedArtifacts,
        projectFileChanges
      );
      const processError = this.processError(command, processResult);
      return {
        output,
        error: processError,
        cancelled: processResult.cancelled
      };
    } catch (error) {
      return {
        output: processResult
          ? commandOutputFromProcess(
              processResult,
              changedFiles,
              promotedArtifacts,
              projectFileChanges
            )
          : undefined,
        error: toWorkspaceCommandError(error)
      };
    } finally {
      skillLease?.release();
      if (hydrated) {
        for (const directory of [
          join(hydrated.workspaceDirectory, "project"),
          ...(projectDirectory ? [projectDirectory] : [])
        ]) {
          await rm(directory, { recursive: true, force: true }).catch(() => {
            cacheReusable = false;
          });
        }
        // The copies of a sandbox without mounts are the command's alone.
        await removeTree(join(hydrated.executionDirectory, LOCAL_SKILL_FOLDERS_DIRECTORY)).catch(
          () => undefined
        );
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

  /** The folders of the skills the command recorded, checked or filled. None without any. */
  private async acquireSkillFolders(
    command: WorkspaceCommand
  ): Promise<SkillFolderLease | undefined> {
    const mounts = command.skillMounts ?? [];
    const [first] = mounts;
    if (!first) return undefined;
    if (!this.skillFolderCache) throw skillMountFailure(first.name, "no_reader");
    return this.skillFolderCache.acquire(command.clientInstanceId, mounts);
  }

  /**
   * What the sandbox is handed: the folders to mount where it mounts them. A sandbox that runs
   * commands as processes of its worker gets writable copies beside the workspace instead.
   */
  private async placeSkillFolders(
    folders: readonly SandboxSkillFolder[],
    executionDirectory: string
  ): Promise<SandboxSkillFolder[]> {
    if (folders.length === 0 || this.processExecutor.mountsSkillFolders) return [...folders];
    const skillsDirectory = join(executionDirectory, LOCAL_SKILL_FOLDERS_DIRECTORY);
    await removeTree(skillsDirectory).catch(() => undefined);
    for (const folder of folders) {
      try {
        await copyFolder(folder.directory, join(skillsDirectory, folder.name));
      } catch {
        // The command is told the skill's name and never a path of the worker.
        throw skillMountFailure(folder.name, "not_copied");
      }
    }
    return [];
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
    signal?: AbortSignal,
    skillFolders: readonly SandboxSkillFolder[] = [],
    projectDirectory?: string
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
      ...(skillFolders.length > 0 ? { skillFolders } : {}),
      ...(projectDirectory ? { projectDirectory } : {}),
      env: {
        HOME: workspaceDirectory,
        PATH: readToolExecutionEnv().path,
        TMPDIR: tempDirectory,
        CATALYST_MAX_WORKSPACE_BYTES: String(command.limits.maxWorkspaceBytes ?? 100 * 1024 * 1024),
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

/** Copies a folder of plain files and folders, writable, never following a link. */
async function copyFolder(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyFolder(from, to);
    } else if (entry.isFile() && (await lstat(from)).isFile()) {
      await writeFile(to, await readFile(from), { flag: "wx" });
    }
  }
}

function commandOutputFromProcess(
  processResult: ProcessResult,
  changedFiles: WorkspaceCommandChangedFile[],
  promotedArtifacts: WorkspaceCommandPromotedArtifact[],
  projectFileChanges: ProjectCommandFileChange[]
): WorkspaceCommandOutput {
  return {
    exitCode: processResult.exitCode,
    stdoutPreview: processResult.stdoutPreview,
    stderrPreview: processResult.stderrPreview,
    durationMs: processResult.durationMs,
    changedFiles,
    promotedArtifacts,
    ...(projectFileChanges.length > 0 ? { projectFileChanges } : {}),
    truncated: processResult.truncated
  };
}

function terminalCommandAuditMetadata(command: WorkspaceCommand): JsonObject {
  return {
    exitCode: command.output?.exitCode ?? null,
    durationMs: command.output?.durationMs ?? null,
    changedFileCount: command.output?.changedFiles.length ?? 0,
    promotedArtifactCount: command.output?.promotedArtifacts.length ?? 0,
    ...(command.output?.projectFileChanges
      ? {
          projectFileChanges: command.output.projectFileChanges.map((change) => ({
            projectId: change.projectId,
            version: change.version,
            change: change.change
          }))
        }
      : {}),
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
