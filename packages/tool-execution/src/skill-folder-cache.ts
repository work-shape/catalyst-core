import {
  isMountableSkillName,
  type ClientInstanceId,
  type SkillFolderFile,
  type SkillFolderReader,
  type WorkspaceCommandSkillMount
} from "@work-shape/catalyst-core";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@work-shape/catalyst-core/sha256";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { WorkspaceRunnerFailure } from "./workspace-command-errors";

// The folders of skills a worker mounts into its commands. One entry per instance and skill
// revision, below the worker's execution root and never inside a workspace:
//
//   <root>/<instance key>/<revision key>/folder/...   what a command sees at /skills/<name>/
//   <root>/<instance key>/<revision key>/manifest.json
//
// An entry is filled in a folder of its own and renamed into place whole, so a command never
// sees one half written. Every use checks the entry against its manifest first: a file that
// changed, went missing, was added, is a link or lost its read-only mode makes the entry be
// filled again, never mounted. The worker only copies bytes: it never runs, imports or parses
// a file of a skill.

/** The folder below the worker's execution root that holds the skill folders. */
export const SKILL_FOLDER_CACHE_DIRECTORY = "catalyst-skill-folders";

const FILE_MODE = 0o444;
const DIRECTORY_MODE = 0o555;
const PRIVATE_DIRECTORY_MODE = 0o700;
const FOLDER = "folder";
const MANIFEST = "manifest.json";
const FILLING_PREFIX = ".fill-";
const DISCARDED_PREFIX = ".discard-";
/** Above what a skill may hold (500 files, 8 MiB), so only a broken reader reaches them. */
const MAX_FILES = 1_000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;
const SOURCE_VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const manifestSchema = z.object({
  clientInstanceId: z.string(),
  name: z.string(),
  revision: z.number(),
  sourceVersion: z.string(),
  files: z.array(
    z.object({ path: z.string(), sha256: z.string().regex(SHA256_PATTERN), bytes: z.number() })
  )
});
type Manifest = z.infer<typeof manifestSchema>;

/** The folder of one skill of a command, ready to be mounted at `/skills/<name>/`. */
interface SkillFolder {
  name: string;
  /** The read-only folder on the worker's disk. */
  directory: string;
}

/** The folders of one command, held until it ends: an entry in use is never evicted. */
export interface SkillFolderLease {
  folders: SkillFolder[];
  release(): void;
}

export class SkillFolderCache {
  private readonly rootDirectory: string;
  private readonly reader: SkillFolderReader;
  private readonly inUse = new Map<string, number>();
  /** The entries an eviction is removing: a command that acquires one waits, then refills it. */
  private readonly evicting = new Map<string, Promise<void>>();

  constructor(options: { rootDirectory: string; reader: SkillFolderReader }) {
    this.rootDirectory = options.rootDirectory;
    this.reader = options.reader;
  }

  /**
   * The folders of the skills a command recorded, each checked or filled. Fails the command
   * with the name of the first skill whose folder cannot be made ready.
   */
  async acquire(
    clientInstanceId: ClientInstanceId,
    mounts: readonly WorkspaceCommandSkillMount[]
  ): Promise<SkillFolderLease> {
    const held: string[] = [];
    const release = () => {
      for (const entry of held.splice(0)) this.unhold(entry);
    };
    try {
      // Every mount is checked before any folder is read.
      const names = new Set<string>();
      for (const mount of mounts) {
        if (!isValidMount(mount) || names.has(mount.name)) {
          throw skillMountFailure(String(mount.name), "invalid_mount");
        }
        names.add(mount.name);
      }
      const folders: SkillFolder[] = [];
      for (const mount of mounts) {
        const entry = this.entryDirectory(clientInstanceId, mount);
        this.hold(entry);
        held.push(entry);
        await this.evicting.get(entry);
        try {
          await this.ensure(clientInstanceId, mount, entry);
        } catch (error) {
          // Whatever failed, the command is told the skill's name and never a path.
          if (error instanceof WorkspaceRunnerFailure) throw error;
          throw skillMountFailure(mount.name, "not_ready");
        }
        folders.push({ name: mount.name, directory: join(entry, FOLDER) });
      }
      return { folders, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Removes the entries no command used for `olderThanMs`, and what a fill or a discard left
   * behind. An entry a command holds stays.
   */
  async evictIdle(input: {
    olderThanMs: number;
    now?: Date;
  }): Promise<{ removedCount: number; failedCount: number }> {
    const cutoffMs = (input.now ?? new Date()).getTime() - input.olderThanMs;
    let removedCount = 0;
    let failedCount = 0;
    for (const instance of await listDirectories(this.rootDirectory)) {
      const instanceDirectory = join(this.rootDirectory, instance);
      for (const name of await listDirectories(instanceDirectory)) {
        const entry = join(instanceDirectory, name);
        if (this.inUse.has(entry)) continue;
        try {
          const info = await lstat(entry);
          if (info.mtimeMs > cutoffMs) continue;
          // Checked again after the wait: a command that acquired the entry meanwhile keeps it.
          // From here a command that acquires it waits for the removal and fills it again.
          if (this.inUse.has(entry)) continue;
          const removal = this.discard(entry);
          this.evicting.set(
            entry,
            removal.catch(() => undefined)
          );
          try {
            await removal;
          } finally {
            this.evicting.delete(entry);
          }
          removedCount += 1;
        } catch {
          failedCount += 1;
        }
      }
    }
    return { removedCount, failedCount };
  }

  private entryDirectory(clientInstanceId: ClientInstanceId, mount: WorkspaceCommandSkillMount) {
    const instanceKey = sha256Hex(`instance\0${clientInstanceId}`).slice(0, 32);
    // The revision is part of the key: a version covers what the agent reads, and two
    // revisions of one version can still differ in the bytes of their SKILL.md.
    const revisionKey = sha256Hex(
      `skill\0${mount.name}\0${String(mount.revision)}\0${mount.sourceVersion}`
    ).slice(0, 40);
    return join(this.rootDirectory, instanceKey, revisionKey);
  }

  private async ensure(
    clientInstanceId: ClientInstanceId,
    mount: WorkspaceCommandSkillMount,
    entry: string
  ): Promise<void> {
    const expected = { clientInstanceId, ...mount };
    const found = await verifyEntry(entry, expected);
    if (found === "valid") {
      await touch(entry);
      return;
    }
    if (found === "invalid") {
      await this.discard(entry);
    }
    let files: SkillFolderFile[];
    try {
      files = await this.reader.read({
        clientInstanceId,
        name: mount.name,
        revision: mount.revision,
        sourceVersion: mount.sourceVersion
      });
    } catch {
      throw skillMountFailure(mount.name, "not_readable");
    }
    const instanceDirectory = dirname(entry);
    await mkdirPrivate(this.rootDirectory);
    await mkdirPrivate(instanceDirectory);
    const filling = join(instanceDirectory, `${FILLING_PREFIX}${randomUUID()}`);
    // Held like an entry, so that an eviction never removes a fill under way.
    this.hold(filling);
    try {
      await fillEntry(filling, mount.name, { ...expected, files: [] }, files);
      try {
        await rename(filling, entry);
      } catch (error) {
        // Another command filled the same entry first: its entry is used if it is sound.
        if (!isCode(error, "ENOTEMPTY") && !isCode(error, "EEXIST")) throw error;
      }
    } catch (error) {
      if (error instanceof WorkspaceRunnerFailure) throw error;
      throw skillMountFailure(mount.name, "not_written");
    } finally {
      await removeTree(filling).catch(() => undefined);
      this.unhold(filling);
    }
    if ((await verifyEntry(entry, expected)) !== "valid") {
      throw skillMountFailure(mount.name, "not_verified");
    }
    await touch(entry);
  }

  /** Moves an entry aside in one step, then removes it. */
  private async discard(entry: string): Promise<void> {
    const aside = join(dirname(entry), `${DISCARDED_PREFIX}${randomUUID()}`);
    try {
      await rename(entry, aside);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    await removeTree(aside).catch(() => undefined);
  }

  private hold(entry: string): void {
    this.inUse.set(entry, (this.inUse.get(entry) ?? 0) + 1);
  }

  private unhold(entry: string): void {
    const count = (this.inUse.get(entry) ?? 1) - 1;
    if (count <= 0) this.inUse.delete(entry);
    else this.inUse.set(entry, count);
  }
}

/** The error code of a command whose skill folder could not be made ready. */
export const SKILL_MOUNT_FAILED_CODE = "WORKSPACE_SKILL_MOUNT_FAILED";

/** The failure of a command whose skill folder could not be made ready. Nothing ran. */
export function skillMountFailure(name: string, cause: string): WorkspaceRunnerFailure {
  return new WorkspaceRunnerFailure(
    SKILL_MOUNT_FAILED_CODE,
    `The folder of the skill '${name}' could not be made ready for the command. Nothing ran.`,
    "runner_error",
    { reason: "skill_mount_failed", skill: name, cause }
  );
}

function isValidMount(mount: WorkspaceCommandSkillMount): boolean {
  return (
    typeof mount.name === "string" &&
    isMountableSkillName(mount.name) &&
    Number.isSafeInteger(mount.revision) &&
    mount.revision > 0 &&
    typeof mount.sourceVersion === "string" &&
    SOURCE_VERSION_PATTERN.test(mount.sourceVersion)
  );
}

/**
 * Whether a path names a file inside its folder: relative, normalized, with no link to follow
 * since the folder is written here from nothing.
 */
function isSkillFolderPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path)) return false;
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  return path
    .split("/")
    .every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && segment.length <= 255
    );
}

async function fillEntry(
  entry: string,
  name: string,
  identity: Manifest,
  files: readonly SkillFolderFile[]
): Promise<void> {
  if (files.length > MAX_FILES) throw skillMountFailure(name, "too_many_files");
  let total = 0;
  const seen = new Set<string>();
  const manifest: Manifest = { ...identity, files: [] };
  await mkdir(entry, { mode: PRIVATE_DIRECTORY_MODE });
  const folder = join(entry, FOLDER);
  await mkdir(folder, { mode: PRIVATE_DIRECTORY_MODE });
  const directories = new Set<string>([folder]);
  for (const file of files) {
    if (!isSkillFolderPath(file.path) || seen.has(file.path)) {
      throw skillMountFailure(name, "invalid_path");
    }
    seen.add(file.path);
    total += file.bytes.byteLength;
    if (total > MAX_BYTES) throw skillMountFailure(name, "too_large");
    if (!SHA256_PATTERN.test(file.sha256) || sha256Hex(file.bytes) !== file.sha256) {
      throw skillMountFailure(name, "hash_mismatch");
    }
    const target = join(folder, ...file.path.split("/"));
    // Each folder on the way is made here; none existed before this fill.
    const segments = file.path.split("/").slice(0, -1);
    let directory = folder;
    for (const segment of segments) {
      directory = join(directory, segment);
      if (!directories.has(directory)) {
        await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
        directories.add(directory);
      }
    }
    // `wx` fails where anything is at the path already, a link included.
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(file.bytes);
    } finally {
      await handle.close();
    }
    await chmod(target, FILE_MODE);
    manifest.files.push({ path: file.path, sha256: file.sha256, bytes: file.bytes.byteLength });
  }
  manifest.files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  // The deepest folders first: a folder made read-only takes no further entry.
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await chmod(directory, DIRECTORY_MODE);
  }
  await writeFile(join(entry, MANIFEST), JSON.stringify(manifest), { flag: "wx", mode: 0o400 });
}

/**
 * Whether an entry holds what its manifest names, exactly: the same files with the same
 * bytes, no other file, no link, files and folders read-only. `missing` where there is none.
 */
async function verifyEntry(
  entry: string,
  expected: Omit<Manifest, "files">
): Promise<"valid" | "invalid" | "missing"> {
  try {
    const info = await lstat(entry);
    if (!info.isDirectory()) return "invalid";
  } catch (error) {
    return isCode(error, "ENOENT") ? "missing" : "invalid";
  }
  try {
    const manifestInfo = await lstat(join(entry, MANIFEST));
    if (!manifestInfo.isFile()) return "invalid";
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(entry, MANIFEST), "utf8"))
    );
    if (
      manifest.clientInstanceId !== expected.clientInstanceId ||
      manifest.name !== expected.name ||
      manifest.revision !== expected.revision ||
      manifest.sourceVersion !== expected.sourceVersion
    ) {
      return "invalid";
    }
    const found = new Map<string, string>();
    const walk = async (directory: string, prefix: string): Promise<boolean> => {
      const info = await lstat(directory);
      if (!info.isDirectory() || (info.mode & 0o777) !== DIRECTORY_MODE) return false;
      for (const child of await readdir(directory, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${child.name}` : child.name;
        const absolute = join(directory, child.name);
        if (child.isDirectory()) {
          if (!(await walk(absolute, path))) return false;
          continue;
        }
        if (!child.isFile()) return false;
        const fileInfo = await lstat(absolute);
        if (!fileInfo.isFile() || (fileInfo.mode & 0o777) !== FILE_MODE) return false;
        found.set(path, absolute);
      }
      return true;
    };
    if (!(await walk(join(entry, FOLDER), ""))) return "invalid";
    if (found.size !== manifest.files.length) return "invalid";
    for (const file of manifest.files) {
      const absolute = found.get(file.path);
      if (!absolute) return "invalid";
      const bytes = await readFile(absolute);
      if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) return "invalid";
    }
    return "valid";
  } catch {
    return "invalid";
  }
}

/** Removes a tree whose folders may be read-only, never following a link. */
export async function removeTree(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  if (info.isDirectory()) {
    const opened = async (directory: string): Promise<void> => {
      await chmod(directory, PRIVATE_DIRECTORY_MODE);
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (child.isDirectory()) await opened(join(directory, child.name));
      }
    };
    await opened(path);
  }
  await rm(path, { recursive: true, force: true });
}

async function mkdirPrivate(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const info = await lstat(directory);
    if (!info.isDirectory()) throw new Error("The skill folder cache is not a folder");
  }
}

async function listDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function touch(entry: string): Promise<void> {
  const now = new Date();
  await utimes(entry, now, now);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
