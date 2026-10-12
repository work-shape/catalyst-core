import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandSearchPath } from "./env";
import { ASSET_REPO_BIG_FILE_THRESHOLD, ASSET_REPO_GIT_TIMEOUT_MS } from "./limits";

// The one place git is started. Every call names its repository, which this command made
// itself, and runs inside it: never in a folder somebody else wrote, where a `.git/config`
// could name a program for git to run. No configuration of the system or of a user takes
// part, hooks are looked for in a directory that is empty, and no transport is allowed.

/** The oldest git this command works with: the first with `merge-tree --write-tree`. */
export const MINIMUM_GIT_VERSION = [2, 38] as const;

/** A full object id of a SHA-1 repository, in lower case. */
export const OBJECT_ID = /^[0-9a-f]{40}$/u;

export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  constructor(args: readonly string[], exit: string, stderr: string) {
    super(`git ${args[0] ?? ""} ended with ${exit}: ${stderr.trim().split("\n")[0] ?? ""}`);
    this.args = args;
    this.stderr = stderr;
  }
}

interface GitRunOptions {
  /** Written to the process as its input. */
  input?: string | Uint8Array;
  /** A file whose bytes from `offset` on are the input of the process. */
  inputFile?: { path: string; offset: number };
  env?: Record<string, string>;
}

/** One repository this command made, and the only way git is run on it. */
export interface Repository {
  readonly directory: string;
  /** Runs git and answers what it wrote. Rejects with `GitError` when it did not end with 0. */
  git(args: readonly string[], options?: GitRunOptions): Promise<string>;
  /** As `git`, and answers whether it ended with 0 instead of rejecting. */
  succeeds(args: readonly string[], options?: GitRunOptions): Promise<boolean>;
}

/** Every setting a call of git is made with. Written before the sub-command, on every call. */
function hardening(emptyDirectory: string): string[] {
  const settings = [
    `core.hooksPath=${emptyDirectory}`,
    "core.fsmonitor=false",
    "protocol.allow=never",
    "safe.bareRepository=explicit",
    "core.symlinks=false",
    "core.protectNTFS=true",
    "core.protectHFS=true",
    `core.bigFileThreshold=${ASSET_REPO_BIG_FILE_THRESHOLD}`,
    "gc.auto=0",
    "maintenance.auto=false",
    "fsck.gitmodulesUrl=error"
  ];
  return settings.flatMap((setting) => ["-c", setting]);
}

function run(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  options: GitRunOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: ASSET_REPO_GIT_TIMEOUT_MS,
      killSignal: "SIGKILL"
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    // A process that ends before it read its input closes the pipe. Its exit says why.
    child.stdin.on("error", () => undefined);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString("utf8"));
      } else {
        reject(
          new GitError(
            args.filter((arg, index) => arg !== "-c" && args[index - 1] !== "-c"),
            signal ? `signal ${signal}` : `exit code ${code}`,
            Buffer.concat(err).toString("utf8")
          )
        );
      }
    });
    if (options.inputFile) {
      createReadStream(options.inputFile.path, { start: options.inputFile.offset })
        .on("error", reject)
        .pipe(child.stdin);
    } else {
      child.stdin.end(options.input ?? "");
    }
  });
}

/**
 * Makes an empty bare repository at `directory`, which must not exist: a repository somebody
 * else left there could hold objects, alternates, refs or settings of its own. `scratch` is a
 * directory this command made
 * and nobody else writes to: it holds the empty directory hooks, templates and a home are
 * looked for in.
 */
export async function createRepository(directory: string, scratch: string): Promise<Repository> {
  const empty = join(scratch, "empty");
  await mkdir(empty, { recursive: true });
  await mkdir(directory);
  const env: Record<string, string> = {
    PATH: commandSearchPath(),
    HOME: empty,
    XDG_CONFIG_HOME: empty,
    LC_ALL: "C",
    GIT_DIR: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_INDEX_FILE: join(scratch, "index")
  };
  const prefix = hardening(empty);
  const git: Repository["git"] = (args, options = {}) =>
    run([...prefix, ...args], directory, { ...env, ...options.env }, options);
  await git(["init", "--quiet", "--bare", `--template=${empty}`, "--initial-branch=draft"]);
  return {
    directory,
    git,
    succeeds: (args, options) =>
      git(args, options).then(
        () => true,
        (error: unknown) => {
          if (error instanceof GitError) {
            return false;
          }
          throw error;
        }
      )
  };
}

/** The version of the git on the path, or nothing when there is none. */
export async function gitVersion(): Promise<[number, number] | undefined> {
  const text = await run(["--version"], tmpdir(), { PATH: commandSearchPath() }, {}).catch(
    () => undefined
  );
  const match = text ? /(\d+)\.(\d+)/u.exec(text) : null;
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export function isSupportedGit(version: readonly [number, number]): boolean {
  const [major, minor] = MINIMUM_GIT_VERSION;
  return version[0] > major || (version[0] === major && version[1] >= minor);
}
