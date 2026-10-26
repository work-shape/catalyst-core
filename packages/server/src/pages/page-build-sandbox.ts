import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_PAGE_BUILD_LIMITS,
  PAGE_BUILD_COMMAND,
  PAGE_BUILD_INPUT_DIRECTORY,
  PAGE_BUILD_OUTPUT_DIRECTORY,
  readPageBuildOutput,
  type PageBuildLimits,
  type PageBuildOutcome,
  type PageFile
} from "@work-shape/catalyst-app-build";
import { fileSetPathIssue } from "@work-shape/catalyst-core";
import {
  DEFAULT_WORKSPACE_COMMAND_PATH,
  type WorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";

// One Page build is one command in the sandbox the instance runs agent commands in. A file of
// a Page is untrusted, and the route generator the build uses can be brought to run one. So the
// build runs where running one reaches nothing: in a container without a network, with a
// read-only root, without capabilities, within the sandbox's CPU, memory and process limits,
// and with one writable directory that holds this build and nothing else.
//
// The worker writes the files into `in/`, runs a fixed command that names no file of the Page,
// and reads `out/` back as data it does not trust.

/** How much of what a build wrote to its error stream is kept for the worker's log. */
const PAGE_BUILD_STDERR_BYTES = 8 * 1024;
/** The build writes nothing to its output stream. More than this ends it. */
const PAGE_BUILD_STDOUT_BYTES = 1024;
/** A shell that did not find the command. */
const EXIT_COMMAND_NOT_FOUND = 127;
/** A process the kernel killed, which a container over its memory limit is. */
const EXIT_KILLED = 137;

/** The start of the name of a build's directory under the temp root. */
const PAGE_BUILD_DIRECTORY_PREFIX = "catalyst-page-build-";
/** The start of the id a build's command has in the sandbox, which names its container. */
const PAGE_BUILD_COMMAND_ID_PREFIX = "page-build-";
/**
 * A directory or container of a build that is at least this old was left by a worker that was
 * killed: a build that runs is ended at its timeout, long before. A longer timeout doubles as
 * the age.
 */
export const PAGE_BUILD_STALE_MS = 15 * 60 * 1000;
/** How often a worker that builds looks for what a killed worker left. */
export const PAGE_BUILD_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface StalePageBuildsInput {
  sandbox: WorkspaceCommandProcessExecutor;
  tempRoot: string;
  /** Replaces `PAGE_BUILD_STALE_MS`. */
  olderThanMs?: number;
  /** Directories of builds that run in this process. */
  active?: ReadonlySet<string>;
  /**
   * The start of the names of the directories and of the command ids to remove, for another
   * fixed command of the worker that leaves the same. A Page build's when left out.
   */
  directoryPrefix?: string;
  commandIdPrefix?: string;
}

/**
 * Removes the directories and containers of builds a killed worker left. Safe next to another
 * worker that builds: only what is older than any running build can be is removed. It never
 * rejects.
 */
export async function removeStalePageBuilds(
  input: StalePageBuildsInput
): Promise<{ directories: number; containers: number }> {
  const olderThanMs = input.olderThanMs ?? PAGE_BUILD_STALE_MS;
  const cutoff = Date.now() - olderThanMs;
  const directoryPrefix = input.directoryPrefix ?? PAGE_BUILD_DIRECTORY_PREFIX;
  const idPrefix = input.commandIdPrefix ?? PAGE_BUILD_COMMAND_ID_PREFIX;
  let directories = 0;
  const entries = await readdir(input.tempRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const directory = join(input.tempRoot, entry.name);
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(directoryPrefix) ||
      input.active?.has(directory)
    ) {
      continue;
    }
    try {
      if ((await lstat(directory)).mtimeMs <= cutoff) {
        await rm(directory, { recursive: true, force: true });
        directories += 1;
      }
    } catch {
      // Gone already, or not this worker's to remove. The next sweep looks again.
    }
  }
  const containers = await Promise.resolve(
    input.sandbox.removeLeftovers?.({ idPrefix, olderThanMs }) ?? 0
  ).catch(() => 0);
  return { directories, containers };
}

export interface SandboxPageBuildOptions {
  /** The sandbox of the instance, the one that runs agent commands. */
  sandbox: WorkspaceCommandProcessExecutor;
  /** Where the directories of builds are made. The sandbox must be able to mount below it. */
  tempRoot: string;
  /**
   * How the build command is started, as shell text. Unset means the command the runner image
   * installs. An instance with the `local` sandbox names the script of this checkout.
   */
  command?: string;
}

export interface SandboxPageBuildInput {
  /** Names the build's container. */
  id: string;
  files: readonly PageFile[];
  signal: AbortSignal;
  limits?: Partial<PageBuildLimits>;
}

export type PageBuildRunner = (input: SandboxPageBuildInput) => Promise<PageBuildOutcome>;

/** Builds Pages in the sandbox. The function never rejects for what a build did. */
export function createSandboxPageBuild(options: SandboxPageBuildOptions): PageBuildRunner {
  const command = options.command ?? PAGE_BUILD_COMMAND;
  const active = new Set<string>();
  let nextSweep = 0;
  return async (input) => {
    const limits = { ...DEFAULT_PAGE_BUILD_LIMITS, ...input.limits };
    if (input.signal.aborted) {
      return { status: "failed", reason: "stopped", message: "The build was stopped." };
    }
    await mkdir(options.tempRoot, { recursive: true });
    // The first build of a worker and one every interval after it clear what a killed worker
    // left. The build does not wait for it.
    if (Date.now() >= nextSweep) {
      nextSweep = Date.now() + PAGE_BUILD_SWEEP_INTERVAL_MS;
      removeStalePageBuilds({
        sandbox: options.sandbox,
        tempRoot: options.tempRoot,
        olderThanMs: Math.max(PAGE_BUILD_STALE_MS, 2 * limits.timeoutMs),
        active
      }).catch(() => undefined);
    }
    const root = await mkdtemp(join(options.tempRoot, PAGE_BUILD_DIRECTORY_PREFIX));
    active.add(root);
    try {
      // The directory the sandbox mounts lies inside the one made above, which no other user
      // of the host can enter.
      const directory = join(root, "build");
      const inputDirectory = join(directory, PAGE_BUILD_INPUT_DIRECTORY);
      const outputDirectory = join(directory, PAGE_BUILD_OUTPUT_DIRECTORY);
      await mkdir(inputDirectory, { recursive: true });
      await mkdir(outputDirectory);
      // The build may run as another user than the worker.
      await chmod(outputDirectory, 0o777);
      for (const file of input.files) {
        const issue = fileSetPathIssue(file.path);
        if (issue) {
          return {
            status: "errors",
            errors: [
              {
                file: file.path,
                code: "file_invalid",
                message: `The file '${file.path}' cannot be built: ${issue}.`
              }
            ]
          };
        }
        const target = join(inputDirectory, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.bytes, { flag: "wx" });
      }
      const result = await options.sandbox.execute({
        command: {
          id: `${PAGE_BUILD_COMMAND_ID_PREFIX}${input.id}`,
          command: `${command} ${PAGE_BUILD_INPUT_DIRECTORY} ${PAGE_BUILD_OUTPUT_DIRECTORY}`,
          limits: {
            timeoutSeconds: Math.ceil(limits.timeoutMs / 1000),
            maxStdoutBytes: PAGE_BUILD_STDOUT_BYTES,
            maxStderrBytes: PAGE_BUILD_STDERR_BYTES
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
      const seconds = Math.ceil(limits.timeoutMs / 1000);
      if (result.cancelled) {
        return { status: "failed", reason: "stopped", message: "The build was stopped." };
      }
      if (result.timeoutKind) {
        return {
          status: "failed",
          reason: "timeout",
          message: `The build did not finish within ${seconds} seconds (PAGE_BUILD_TIMEOUT_MS) and was stopped.`
        };
      }
      if (result.spawnError) {
        return {
          status: "failed",
          reason: "crashed",
          message: "The sandbox that builds Pages could not be started.",
          detail: result.spawnError.message
        };
      }
      if (result.exitCode === EXIT_COMMAND_NOT_FOUND) {
        return {
          status: "failed",
          reason: "command_missing",
          message: `The runner image of this instance has no '${PAGE_BUILD_COMMAND}'. It is older than the release that builds Pages: a problem of the platform, not of the request, solved by rolling out the runner image of this release.`,
          detail: result.stderrPreview
        };
      }
      if (result.exitCode === EXIT_KILLED) {
        return {
          status: "failed",
          reason: "out_of_memory",
          message:
            "The build was ended, most likely because it needed more memory than the sandbox gives a command.",
          detail: result.stderrPreview
        };
      }
      if (result.exitCode !== 0) {
        return {
          status: "failed",
          reason: "crashed",
          message: "The build ended without a result.",
          detail: result.stderrPreview
        };
      }
      return await readPageBuildOutput(outputDirectory, limits);
    } finally {
      active.delete(root);
      // A directory that cannot be removed now is removed by a later sweep.
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
