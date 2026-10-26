import {
  ASSET_REPO_BUNDLES_DIRECTORY,
  ASSET_REPO_COMMAND,
  ASSET_REPO_COMMIT_DISK_BYTES,
  ASSET_REPO_FOLDER_DIRECTORY,
  ASSET_REPO_MAX_BUNDLE_BYTES,
  ASSET_REPO_NO_SPACE_MARK,
  ASSET_REPO_NO_SPACE_MESSAGE,
  ASSET_REPO_OUTPUT_DIRECTORY,
  ASSET_REPO_REQUEST_FILE,
  ASSET_REPO_RESULT_FILE,
  ASSET_REPO_WORK_DIRECTORY,
  treeRefusal,
  type AssetRepoRefusal,
  type CommitFolderRequest
} from "@work-shape/catalyst-asset-repo";
import { ASSET_REPO_BUNDLE_KINDS } from "@work-shape/catalyst-core";
import {
  DEFAULT_WORKSPACE_COMMAND_PATH,
  type WorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { removeStalePageBuilds } from "../pages/page-build-sandbox";

// One commit of a folder is one command in the sandbox the instance runs agent commands in.
// The files of the folder are untrusted, and so is every bundle that is not the bytes the
// ledger recorded. Git reads both where reading them reaches nothing: in a container without
// a network, with a read-only root and without capabilities, as `catalyst-asset-repo`, which
// starts git with a fixed environment and no file of the folder as configuration.
//
// The worker writes the request, the bundles and the files, runs the fixed command, and reads
// `out/` back as data it does not trust: the result has to have its form, and the bundle has
// to be a regular file with the size and the hash the result names.
//
// Everything a commit takes is on the disk of the worker, below the one directory the
// container mounts: what the worker wrote and `work/`, where the command keeps its
// repository and its copies. Nothing of it is in the `/tmp` of the sandbox, a tmpfs of 64 MiB
// that counts against the memory of the container. So the memory of the container holds git
// and the command alone, which read a file of at most `ASSET_REPO_MAX_FILE_BYTES` at a time,
// and the room of a commit is `ASSET_REPO_COMMIT_DISK_BYTES` of disk, which is asked for
// before the container starts.

/** How long one commit may take. The command ends each git process after a minute itself. */
export const ASSET_REPO_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
/** How much of the command's error stream is kept for the worker's log. */
const ASSET_REPO_STDERR_BYTES = 8 * 1024;
/** The command writes nothing to its output stream. More than this ends it. */
const ASSET_REPO_STDOUT_BYTES = 1024;
/** The result names a commit, a tree and a bundle, or a refusal with one path. */
const ASSET_REPO_MAX_RESULT_BYTES = 64 * 1024;
const EXIT_COMMAND_NOT_FOUND = 127;

const ASSET_REPO_DIRECTORY_PREFIX = "catalyst-asset-repo-";
const ASSET_REPO_COMMAND_ID_PREFIX = "asset-repo-";
/** What a killed worker left of a commit is at least this old. */
const ASSET_REPO_STALE_MS = 15 * 60 * 1000;
const ASSET_REPO_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const OBJECT_ID = /^[0-9a-f]{40}$/u;
const committedSchema = z.object({
  status: z.literal("committed"),
  commit: z.string().regex(OBJECT_ID),
  tree: z.string().regex(OBJECT_ID),
  parent: z.string().regex(OBJECT_ID).nullable(),
  files: z.number().int().nonnegative(),
  bundle: z.object({
    file: z.string().min(1).max(256),
    kind: z.enum(ASSET_REPO_BUNDLE_KINDS),
    prerequisite: z.string().regex(OBJECT_ID).nullable(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().positive().max(ASSET_REPO_MAX_BUNDLE_BYTES)
  })
});
const refusedSchema = z.object({
  status: z.literal("refused"),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  path: z.string().max(4096).optional(),
  message: z.string().min(1).max(2000)
});
const resultSchema = z.union([committedSchema, refusedSchema]);

export interface SandboxAssetRepoOptions {
  /** The sandbox of the instance, the one that runs agent commands. */
  sandbox: WorkspaceCommandProcessExecutor;
  /** Where the directories of commits are made. The sandbox must be able to mount below it. */
  tempRoot: string;
  /**
   * How the command is started, as shell text. Unset means the command the runner image
   * installs. An instance with the `local` sandbox names the script of this checkout.
   */
  command?: string;
  timeoutMs?: number;
}

export interface AssetRepoCommitInput {
  /** Names the container of the commit. */
  id: string;
  request: Omit<CommitFolderRequest, "bundles">;
  /** The files of the folder. */
  files: readonly { path: string; bytes: Uint8Array }[];
  /**
   * The bundles of the repository in the order of the ledger, each with the bytes the worker
   * read and checked against the hash and the size named here.
   */
  bundles: readonly {
    tip: string;
    prerequisite: string | null;
    sha256: string;
    bytes: Uint8Array;
  }[];
  signal: AbortSignal;
}

export type AssetRepoCommitOutcome =
  | {
      status: "committed";
      commit: string;
      tree: string;
      files: number;
      bundle: {
        kind: (typeof ASSET_REPO_BUNDLE_KINDS)[number];
        prerequisite: string | null;
        sha256: string;
        bytes: Uint8Array;
      };
    }
  | AssetRepoRefusal
  | {
      status: "failed";
      reason: "stopped" | "timeout" | "command_missing" | "crashed";
      message: string;
      detail?: string;
    };

export type AssetRepoCommitRunner = (
  input: AssetRepoCommitInput
) => Promise<AssetRepoCommitOutcome>;

class OutputRefused extends Error {}

/** The disk of the worker has no room for the commit: a refusal an operator can act on. */
const NO_SPACE: AssetRepoRefusal = {
  status: "refused",
  code: "no_space",
  message: ASSET_REPO_NO_SPACE_MESSAGE
};

/** Reads a file the command wrote: a regular file of at most `maxBytes`, never through a link. */
async function readWritten(path: string, maxBytes: number, what: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new OutputRefused(`The command left no ${what}.`);
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) {
      throw new OutputRefused(`The ${what} of the command is not a file of the size it may have.`);
    }
    const bytes = new Uint8Array(stats.size);
    let read = 0;
    while (read < bytes.byteLength) {
      const step = await handle.read(bytes, read, bytes.byteLength - read, read);
      if (step.bytesRead === 0) {
        throw new OutputRefused(`The ${what} of the command changed while it was read.`);
      }
      read += step.bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readOutput(
  outputDirectory: string,
  base: string | null
): Promise<AssetRepoCommitOutcome> {
  const text = await readWritten(
    join(outputDirectory, ASSET_REPO_RESULT_FILE),
    ASSET_REPO_MAX_RESULT_BYTES,
    "result"
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(text));
  } catch {
    throw new OutputRefused("The result of the command is not JSON.");
  }
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) {
    throw new OutputRefused("The result of the command does not have the expected form.");
  }
  const result = parsed.data;
  if (result.status === "refused") {
    return {
      status: "refused",
      code: result.code,
      message: result.message,
      ...(result.path === undefined ? {} : { path: result.path })
    };
  }
  const { bundle } = result;
  // The commit stands on the base the worker named and comes in the bundle the ledger takes
  // for it: a full one for a first commit, and otherwise one that stands on the base.
  if (
    result.parent !== base ||
    bundle.prerequisite !== base ||
    (bundle.kind === "full") !== (base === null) ||
    bundle.file !== `${result.commit}.bundle`
  ) {
    throw new OutputRefused("The commit of the command does not stand on the base it was given.");
  }
  const bytes = await readWritten(join(outputDirectory, bundle.file), bundle.bytes, "bundle");
  if (
    bytes.byteLength !== bundle.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== bundle.sha256
  ) {
    throw new OutputRefused("The bundle of the command is not the one its result names.");
  }
  return {
    status: "committed",
    commit: result.commit,
    tree: result.tree,
    files: result.files,
    bundle: { kind: bundle.kind, prerequisite: bundle.prerequisite, sha256: bundle.sha256, bytes }
  };
}

/** Commits folders in the sandbox. The function never rejects for what a commit did. */
export function createSandboxAssetRepo(options: SandboxAssetRepoOptions): AssetRepoCommitRunner {
  const command = options.command ?? ASSET_REPO_COMMAND;
  const timeoutMs = options.timeoutMs ?? ASSET_REPO_COMMAND_TIMEOUT_MS;
  const active = new Set<string>();
  let nextSweep = 0;
  return async (input) => {
    if (input.signal.aborted) {
      return { status: "failed", reason: "stopped", message: "The save was stopped." };
    }
    // What the tree check of the command refuses is refused here first, on the paths and the
    // sizes alone, so that no such path is ever written below the directory of the commit.
    const refusal = treeRefusal(
      input.files.map((file) => ({
        path: file.path,
        mode: "100644",
        size: file.bytes.byteLength
      }))
    );
    if (refusal) {
      return { status: "refused", ...refusal };
    }
    await mkdir(options.tempRoot, { recursive: true });
    // A commit is not started where the disk cannot hold the largest one.
    const disk = await statfs(options.tempRoot);
    if (disk.bavail * disk.bsize < ASSET_REPO_COMMIT_DISK_BYTES) {
      return NO_SPACE;
    }
    if (Date.now() >= nextSweep) {
      nextSweep = Date.now() + ASSET_REPO_SWEEP_INTERVAL_MS;
      removeStalePageBuilds({
        sandbox: options.sandbox,
        tempRoot: options.tempRoot,
        olderThanMs: Math.max(ASSET_REPO_STALE_MS, 2 * timeoutMs),
        active,
        directoryPrefix: ASSET_REPO_DIRECTORY_PREFIX,
        commandIdPrefix: ASSET_REPO_COMMAND_ID_PREFIX
      }).catch(() => undefined);
    }
    const root = await mkdtemp(join(options.tempRoot, ASSET_REPO_DIRECTORY_PREFIX));
    active.add(root);
    try {
      // The directory the sandbox mounts lies inside the one made above, which no other user
      // of the host can enter.
      const directory = join(root, "commit");
      const folder = join(directory, ASSET_REPO_FOLDER_DIRECTORY);
      const bundlesDirectory = join(directory, ASSET_REPO_BUNDLES_DIRECTORY);
      const outputDirectory = join(directory, ASSET_REPO_OUTPUT_DIRECTORY);
      await mkdir(folder, { recursive: true });
      await mkdir(bundlesDirectory);
      await mkdir(outputDirectory);
      const workDirectory = join(directory, ASSET_REPO_WORK_DIRECTORY);
      await mkdir(workDirectory);
      // The command may run as another user than the worker.
      await chmod(outputDirectory, 0o777);
      await chmod(workDirectory, 0o777);
      const bundles = input.bundles.map((bundle, index) => ({
        file: `${String(index).padStart(6, "0")}.bundle`,
        tip: bundle.tip,
        prerequisite: bundle.prerequisite,
        sha256: bundle.sha256,
        bytes: bundle.bytes.byteLength
      }));
      for (const [index, bundle] of input.bundles.entries()) {
        const file = bundles[index]?.file;
        if (file !== undefined) {
          await writeFile(join(bundlesDirectory, file), bundle.bytes, { flag: "wx" });
        }
      }
      for (const file of input.files) {
        const target = join(folder, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.bytes, { flag: "wx" });
      }
      const request: CommitFolderRequest = { ...input.request, bundles };
      await writeFile(join(directory, ASSET_REPO_REQUEST_FILE), JSON.stringify(request), {
        flag: "wx"
      });
      const result = await options.sandbox.execute({
        command: {
          id: `${ASSET_REPO_COMMAND_ID_PREFIX}${input.id}`,
          command: `${command} commit-folder .`,
          limits: {
            timeoutSeconds: Math.ceil(timeoutMs / 1000),
            maxStdoutBytes: ASSET_REPO_STDOUT_BYTES,
            maxStderrBytes: ASSET_REPO_STDERR_BYTES
          }
        },
        workspaceDirectory: directory,
        workspaceCwd: ".",
        cwd: directory,
        tempDirectory: join(root, "tmp"),
        env: {
          HOME: directory,
          PATH: DEFAULT_WORKSPACE_COMMAND_PATH,
          TMPDIR: join(root, "tmp"),
          WORKSPACE_DIR: directory
        },
        signal: input.signal
      });
      if (result.cancelled) {
        return { status: "failed", reason: "stopped", message: "The save was stopped." };
      }
      if (result.timeoutKind) {
        return {
          status: "failed",
          reason: "timeout",
          message: `The commit did not finish within ${Math.ceil(timeoutMs / 1000)} seconds and was stopped.`
        };
      }
      if (result.spawnError) {
        return {
          status: "failed",
          reason: "crashed",
          message: "The sandbox that writes repositories could not be started.",
          detail: result.spawnError.message
        };
      }
      if (result.exitCode === EXIT_COMMAND_NOT_FOUND) {
        return {
          status: "failed",
          reason: "command_missing",
          message: `The runner image of this instance has no '${ASSET_REPO_COMMAND}'. It is older than the release that keeps repositories: a problem of the platform, not of the request, solved by rolling out the runner image of this release.`,
          detail: result.stderrPreview
        };
      }
      if (result.exitCode !== 0 && result.stderrPreview.includes(ASSET_REPO_NO_SPACE_MARK)) {
        return NO_SPACE;
      }
      if (result.exitCode !== 0) {
        return {
          status: "failed",
          reason: "crashed",
          message: "The commit ended without a result.",
          detail: result.stderrPreview
        };
      }
      // A link at the place of the output directory is not followed.
      if (!(await lstat(outputDirectory).catch(() => undefined))?.isDirectory()) {
        return {
          status: "failed",
          reason: "crashed",
          message: "The command left no output directory."
        };
      }
      return await readOutput(outputDirectory, input.request.base);
    } catch (error) {
      if (error instanceof OutputRefused) {
        return { status: "failed", reason: "crashed", message: error.message };
      }
      // The disk filled while the worker wrote the files of the commit.
      if (error instanceof Error && "code" in error && error.code === "ENOSPC") {
        return NO_SPACE;
      }
      throw error;
    } finally {
      active.delete(root);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
