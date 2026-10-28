import {
  readObjectBytes,
  type ExecutionWorkspace,
  type ObjectStorage,
  type PlatformStores,
  type WorkspaceCommand,
  type WorkspaceFile
} from "@work-shape/catalyst-core";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { WorkspaceRunnerFailure } from "./workspace-command-errors";
import { normalizeWorkspaceFilePath, resolveWorkspaceFilesystemPath } from "./workspace-paths";
import { createWorkspaceChecksum } from "./workspace-tool-results";

const DEFAULT_WORKSPACE_BYTES = 100 * 1024 * 1024;

/** The folders every command finds in the workspace. None of them can be a file. */
export const STANDARD_WORKSPACE_DIRECTORIES = ["scripts", "artifacts", "previews", "tmp"] as const;

export interface HydratedWorkspace {
  executionDirectory: string;
  workspaceDirectory: string;
  baselineFiles: Map<string, WorkspaceFile>;
}

export interface ScannedWorkspaceFile {
  path: string;
  bytes: Uint8Array;
  byteSize: number;
  checksum: string;
  mimeType?: string;
}

function cachedWorkspaceDirectoryName(workerId: string, workspaceId: string): string {
  const key = createHash("sha256").update(`${workerId}:${workspaceId}`).digest("hex").slice(0, 32);
  return `catalyst-workspace-${key}`;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
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

export async function hydrateWorkspace(
  context: WorkspaceCommandFileContext,
  workspace: ExecutionWorkspace,
  command: WorkspaceCommand
): Promise<HydratedWorkspace> {
  await mkdir(context.tempRootDirectory, { recursive: true });
  const executionDirectory = context.reuseWorkspaceDirectories
    ? join(context.tempRootDirectory, cachedWorkspaceDirectoryName(context.workerId, workspace.id))
    : await mkdtemp(join(context.tempRootDirectory, "catalyst-workspace-"));
  const workspaceDirectory = join(executionDirectory, "workspace");
  try {
    let cachedFiles: ScannedWorkspaceFile[] = [];
    if (context.reuseWorkspaceDirectories) {
      try {
        await mkdir(workspaceDirectory, { recursive: true });
        const accessedAt = new Date();
        await utimes(executionDirectory, accessedAt, accessedAt);
        await context.ensureStandardWorkspaceDirectories(workspaceDirectory);
        cachedFiles = await context.scanWorkspaceFiles(workspaceDirectory, command);
      } catch {
        await rm(executionDirectory, { recursive: true, force: true });
      }
    }
    await mkdir(workspaceDirectory, { recursive: true });
    await context.ensureStandardWorkspaceDirectories(workspaceDirectory);
    const files = (
      await context.store.executionWorkspaces.listWorkspaceFiles({
        clientInstanceId: command.clientInstanceId,
        workspaceId: workspace.id
      })
    ).filter((file) => file.path !== "project" && !file.path.startsWith("project/"));
    // This reserved path is filled separately, after the run's project access is checked.
    await rm(join(workspaceDirectory, "project"), { recursive: true, force: true });
    const durablePaths = new Set(files.map((file) => file.path));
    const cachedPaths = new Set(cachedFiles.map((file) => file.path));
    if (context.reuseWorkspaceDirectories && !setsEqual(cachedPaths, durablePaths)) {
      await rm(executionDirectory, { recursive: true, force: true });
      await mkdir(workspaceDirectory, { recursive: true });
      await context.ensureStandardWorkspaceDirectories(workspaceDirectory);
      cachedFiles = [];
    }
    const cachedByPath = new Map(cachedFiles.map((file) => [file.path, file]));
    const baselineFiles = new Map<string, WorkspaceFile>();
    for (const file of files) {
      const normalized = normalizeWorkspaceFilePath(file.path, {
        maxPathLength: context.maxPathLength
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
        maxPathLength: context.maxPathLength
      });
      if (target.status === "failed") {
        throw new WorkspaceRunnerFailure(
          "WORKSPACE_FILE_PATH_REJECTED",
          target.message,
          "runner_error",
          target.details
        );
      }
      const cached = cachedByPath.get(normalized.value);
      if (cached?.checksum !== file.checksum || cached.byteSize !== file.byteSize) {
        const bytes = await readObjectBytes(context.byteStore, file.objectKey);
        await mkdir(dirname(target.value), { recursive: true });
        await writeFile(target.value, bytes);
      }
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
  } catch (error) {
    await rm(executionDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function ensureStandardWorkspaceDirectories(
  workspaceDirectory: string
): Promise<void> {
  for (const directory of STANDARD_WORKSPACE_DIRECTORIES) {
    await mkdir(join(workspaceDirectory, directory), { recursive: true });
  }
}

interface WorkspaceScanOptions {
  skipProjectDirectory?: boolean;
  maxBytes?: number;
  maxFileBytes?: number;
  maxFiles?: number;
}

export async function scanWorkspaceFiles(
  maxPathLength: number,
  workspaceDirectory: string,
  command: WorkspaceCommand,
  options: WorkspaceScanOptions = {}
): Promise<ScannedWorkspaceFile[]> {
  const scanned: ScannedWorkspaceFile[] = [];
  for await (const file of iterateWorkspaceFiles(
    maxPathLength,
    workspaceDirectory,
    command,
    options
  )) {
    scanned.push(file);
  }
  return scanned.sort((left, right) => left.path.localeCompare(right.path));
}

/** Projects can hold GiBs: their scan keeps one file's bytes in memory at a time. */
export async function* iterateWorkspaceFiles(
  maxPathLength: number,
  workspaceDirectory: string,
  command: WorkspaceCommand,
  options: WorkspaceScanOptions = {}
): AsyncGenerator<ScannedWorkspaceFile> {
  let scannedCount = 0;
  let totalBytes = 0;
  const scanDirectory = async function* (directory: string): AsyncGenerator<ScannedWorkspaceFile> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const workspacePath = relative(workspaceDirectory, absolutePath).split("\\").join("/");
      if ((options.skipProjectDirectory ?? true) && workspacePath === "project") continue;
      if (entry.isSymbolicLink()) {
        throw new WorkspaceRunnerFailure(
          "WORKSPACE_SYMLINK_REJECTED",
          "Workspace files must not be symbolic links",
          "runner_error",
          { path: workspacePath }
        );
      }
      if (entry.isDirectory()) {
        yield* scanDirectory(absolutePath);
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
        maxPathLength: maxPathLength
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
      const maxBytes =
        options.maxBytes ?? command.limits.maxWorkspaceBytes ?? DEFAULT_WORKSPACE_BYTES;
      if (
        totalBytes > maxBytes ||
        stats.size > (options.maxFileBytes ?? maxBytes) ||
        scannedCount >= (options.maxFiles ?? Infinity)
      ) {
        throw new WorkspaceRunnerFailure(
          "WORKSPACE_SIZE_LIMIT_EXCEEDED",
          "Workspace size limit exceeded",
          "runner_error",
          {
            path: normalized.value,
            totalBytes,
            maxWorkspaceBytes: maxBytes
          }
        );
      }
      const bytes = await readFile(absolutePath);
      scannedCount += 1;
      yield {
        path: normalized.value,
        bytes,
        byteSize: bytes.byteLength,
        checksum: createWorkspaceChecksum(bytes),
        mimeType: inferWorkspaceMimeType(normalized.value)
      };
    }
  };
  yield* scanDirectory(workspaceDirectory);
}

interface WorkspaceCommandFileContext {
  store: Pick<PlatformStores, "files" | "executionWorkspaces">;
  byteStore: ObjectStorage;
  workerId: string;
  tempRootDirectory: string;
  maxPathLength: number;
  reuseWorkspaceDirectories: boolean;
  ensureStandardWorkspaceDirectories(workspaceDirectory: string): Promise<void>;
  scanWorkspaceFiles(
    workspaceDirectory: string,
    command: WorkspaceCommand
  ): Promise<ScannedWorkspaceFile[]>;
}
