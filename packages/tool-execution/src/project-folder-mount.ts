import {
  normalizeProjectFilePath,
  type ProjectCommandFileChange,
  type ProjectCommandFolder,
  type ProjectCommandFolderPort,
  type ProjectFile,
  PROJECT_FILE_PATH_MAX_LENGTH,
  type WorkspaceCommand
} from "@work-shape/catalyst-core";
import { sha256Hex } from "@work-shape/catalyst-core/sha256";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspaceRunnerFailure } from "./workspace-command-errors";
import { iterateWorkspaceFiles, type ScannedWorkspaceFile } from "./workspace-command-files";

/** Hash-named objects on this host, never mounted or linked into a command's writable folder. */
const CACHE_DIRECTORY = "catalyst-project-files";

export interface PreparedProjectFolder extends ProjectCommandFolder {
  directory: string;
  baseline: Map<string, ProjectFile>;
}

/** A command gets its own snapshot. Only the immutable bytes are shared by commands. */
export class ProjectFolderMounts {
  private readonly cacheDirectory: string;

  constructor(private readonly options: { rootDirectory: string; port: ProjectCommandFolderPort }) {
    this.cacheDirectory = join(options.rootDirectory, CACHE_DIRECTORY);
  }

  async prepare(
    command: WorkspaceCommand,
    directory: string
  ): Promise<PreparedProjectFolder | undefined> {
    const access = await this.options.port.folderOfCommand(command);
    if (!access) return undefined;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = await this.options.port.list(access.folder);
    const baseline = new Map<string, ProjectFile>();
    for (const file of files) {
      if (normalizeProjectFilePath(file.path) !== file.path) throw projectMountFailure();
      const bytes = await this.cachedBytes(access, file);
      const target = join(directory, file.path);
      await mkdir(dirname(target), { recursive: true });
      // A copy, never a hard link: a script cannot change another command's snapshot or cache.
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      baseline.set(file.path, file);
    }
    return { ...access, directory, baseline };
  }

  async sync(
    command: WorkspaceCommand,
    mount: PreparedProjectFolder,
    changed: ProjectCommandFileChange[]
  ): Promise<void> {
    // Membership, audience or chat assignment may have changed while the command ran.
    const current = await this.options.port.folderOfCommand(command);
    if (current?.folder.projectId !== mount.folder.projectId || current.userId !== mount.userId) {
      throw projectMountFailure();
    }
    let present = true;
    try {
      if (!(await lstat(mount.directory)).isDirectory()) throw projectMountFailure();
    } catch (error) {
      if (hasCode(error, "ENOENT")) present = false;
      else throw error;
    }
    const limits = this.options.port.limits;
    const scanned: Omit<ScannedWorkspaceFile, "bytes">[] = [];
    if (present) {
      // Check the entire tree and its caps before writing. Retain metadata, never the whole
      // project's bytes; only changed files need a second read below.
      for await (const file of iterateWorkspaceFiles(
        PROJECT_FILE_PATH_MAX_LENGTH,
        mount.directory,
        command,
        {
          skipProjectDirectory: false,
          maxBytes: limits.maxProjectBytes,
          maxFileBytes: limits.maxFileBytes,
          maxFiles: limits.maxFiles
        }
      )) {
        if (normalizeProjectFilePath(file.path) !== file.path) throw projectMountFailure();
        const { bytes: _bytes, ...metadata } = file;
        scanned.push(metadata);
      }
    }
    const found = new Set(scanned.map((file) => file.path));
    for (const file of scanned) {
      const before = mount.baseline.get(file.path);
      if (before?.checksum === file.checksum && before.byteSize === file.byteSize) continue;
      const result = await this.options.port.write(mount.folder, {
        path: file.path,
        bytes: await readFile(join(mount.directory, file.path)),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        replaces: before?.version ?? 0,
        userId: mount.userId,
        runId: command.agentRunId,
        ...(mount.locale ? { locale: mount.locale } : {})
      });
      changed.push({ ...result, projectId: mount.folder.projectId });
    }
    // An edit by another command wins over this command's deletion (the PRJ-2 conflict rule).
    for (const file of mount.baseline.values()) {
      if (found.has(file.path) || !command.agentRunId) continue;
      const result = await this.options.port.removeVersion(mount.folder, {
        path: file.path,
        replaces: file.version,
        userId: mount.userId,
        runId: command.agentRunId
      });
      if (result) changed.push({ ...result, projectId: mount.folder.projectId });
    }
  }

  async evictIdle(input: { olderThanMs: number; now?: Date }) {
    let removedCount = 0;
    let failedCount = 0;
    const cutoff = (input.now ?? new Date()).getTime() - input.olderThanMs;
    const entries = await readdir(this.cacheDirectory).catch(() => []);
    for (const name of entries) {
      const entry = join(this.cacheDirectory, name);
      try {
        if ((await lstat(entry)).mtimeMs > cutoff) continue;
        await rm(entry, { force: true });
        removedCount += 1;
      } catch (error) {
        if (!hasCode(error, "ENOENT")) failedCount += 1;
      }
    }
    return { removedCount, failedCount };
  }

  private async cachedBytes(access: ProjectCommandFolder, file: ProjectFile): Promise<Uint8Array> {
    const key = sha256Hex(
      JSON.stringify([access.folder.clientInstanceId, access.folder.projectId, file.checksum])
    );
    await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
    const entry = join(this.cacheDirectory, key);
    try {
      if ((await lstat(entry)).isFile()) {
        const bytes = await readFile(entry);
        if (bytes.byteLength === file.byteSize && sha256Hex(bytes) === file.checksum) {
          const now = new Date();
          await utimes(entry, now, now).catch(() => undefined);
          return bytes;
        }
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw projectMountFailure();
    }
    const bytes = await this.options.port.readVersion(access.folder, file);
    if (bytes.byteLength !== file.byteSize || sha256Hex(bytes) !== file.checksum) {
      throw projectMountFailure();
    }
    const filling = join(this.cacheDirectory, `.fill-${randomUUID()}`);
    try {
      await writeFile(filling, bytes, { flag: "wx", mode: 0o600 });
      await rename(filling, entry);
    } finally {
      await rm(filling, { force: true });
    }
    return bytes;
  }
}

function projectMountFailure(): WorkspaceRunnerFailure {
  return new WorkspaceRunnerFailure(
    "WORKSPACE_PROJECT_MOUNT_FAILED",
    "The project's folder could not be prepared or saved for this command.",
    "runner_error"
  );
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
