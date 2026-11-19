import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { WorkspaceCommand } from "@work-shape/catalyst-core";

export const DEFAULT_WORKSPACE_COMMAND_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const DEFAULT_WORKSPACE_COMMAND_SHELL = "/bin/bash";

/**
 * What a sandbox reads of a command: a name for what it starts, the shell text and the limits
 * of the process. A workspace command is one; so is a command the platform runs itself.
 */
export interface SandboxCommand {
  id: string;
  command: string;
  limits: Pick<
    WorkspaceCommand["limits"],
    "timeoutSeconds" | "idleTimeoutSeconds" | "maxStdoutBytes" | "maxStderrBytes"
  >;
}

/**
 * Limits of one command that are lower than the sandbox's own: a kind of command the platform
 * runs itself, such as the script of a Workflow's code step, is given less than an agent's
 * command. A sandbox that runs commands as processes of its worker has no such limits.
 */
export interface SandboxCommandLimits {
  cpuCount: number;
  /** The memory of the command, with no swap beyond it. */
  memoryBytes: number;
  pidsLimit: number;
  /**
   * With it the command cannot write to the worker's disk at all. Its working directory,
   * `/workspace`, is a file system in memory of this size, which counts against
   * `memoryBytes`: a command that fills it reads "no space left". The workspace directory of
   * the worker is handed in read-only as `SANDBOX_SOURCE_DIRECTORY`, and the command copies
   * what it needs from there.
   */
  scratchBytes?: number;
}

/** Where a command with a scratch directory finds the directory its worker filled. */
export const SANDBOX_SOURCE_DIRECTORY = "/code";

/**
 * Where a sandbox of its own hands in the data directories of a command: the files its worker
 * wrote for it, read-only, and the directory on the worker's disk it writes files to.
 */
export const SANDBOX_DATA_DIRECTORIES = { input: "/work/in", output: "/work/out" } as const;

/** Two directories of the worker, beside the workspace directory. */
export interface SandboxDataDirectories {
  /** What the worker wrote for the command. Read-only for the command. */
  input: string;
  /** Empty when the command starts. The command writes its files there, on the worker's disk. */
  output: string;
}

/** The folder of one skill on the worker's disk, and the name it has below `/skills`. */
export interface SandboxSkillFolder {
  name: string;
  directory: string;
}

/**
 * A channel a command talks to its worker on while it runs, without a network (TOOL-2c). The
 * command writes each request as one line on its output stream and reads each answer as one
 * line on its input stream, in order. After its last request it writes `endMark` on a line of
 * its own: what follows on its output stream is its output, as without a channel.
 */
export interface SandboxRequestChannel {
  /** A line nobody but this run knows. */
  endMark: string;
  /** The longest request read, in bytes. A longer line is dropped and answered `refuse`. */
  maxLineBytes: number;
  /**
   * The most lines answered. Past them the command's input stream is closed and what it still
   * writes before the end mark is dropped. The requests are read up to `maxLines` lines of
   * `maxLineBytes` and their line breaks, apart from the command's `maxStdoutBytes`, which
   * bounds its output alone; past them the channel closes too.
   */
  maxLines: number;
  /** The answer to one request: one line, without a line break. It never rejects. */
  answer(line: string): Promise<string>;
  /** The answer to a line that is no request: one longer than `maxLineBytes`. */
  refuse(reason: "too_long"): string;
}

export interface WorkspaceCommandProcessInput {
  command: SandboxCommand;
  /**
   * Where the command asks its worker for something while it runs. Only a command the platform
   * runs itself has one: an agent's command has none.
   */
  requests?: SandboxRequestChannel;
  /** In place of the sandbox's own CPU, memory and process limits. */
  sandboxLimits?: SandboxCommandLimits;
  /**
   * Data directories for a command with limits of its own. A sandbox that has `dataPaths`
   * hands them in at those paths; one without runs the command where it reaches the worker's
   * own paths.
   */
  dataDirectories?: SandboxDataDirectories;
  /**
   * The folders of the skills of the command's agent run, each mounted read-only at
   * `/skills/<name>/` by a sandbox that `mountsSkillFolders`. Only a workspace command of an
   * agent run has any; a command the platform runs itself has none.
   */
  skillFolders?: readonly SandboxSkillFolder[];
  /** A command's writable snapshot, mounted at /workspace/project by a sandbox with mounts. */
  projectDirectory?: string;
  workspaceDirectory: string;
  workspaceCwd: string;
  cwd: string;
  tempDirectory: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number;
  stdoutPreview: string;
  stderrPreview: string;
  truncated: {
    stdout: boolean;
    stderr: boolean;
  };
  durationMs: number;
  timeoutKind?: "wall" | "idle";
  cancelled?: boolean;
  cancellationReason?: string;
  spawnError?: Error;
  /**
   * Whether the sandbox ended a process of the command because the command was over its
   * memory. Set by a sandbox that can read it for a command with limits of its own, and
   * missing everywhere else: an exit code alone does not say it.
   */
  outOfMemory?: boolean;
}

export interface WorkspaceCommandProcessExecutor {
  /**
   * Where the command sees `dataDirectories`. Missing for a sandbox that runs the command as a
   * process of its worker: the command then sees the worker's own paths.
   */
  readonly dataPaths?: SandboxDataDirectories;
  /**
   * Whether the sandbox mounts `skillFolders` read-only at `/skills/<name>/`. A sandbox without
   * it runs commands as processes of its worker, which find copies of the folders beside the
   * workspace instead, writable: for development only.
   */
  readonly mountsSkillFolders?: boolean;
  readonly mountsProjectFolder?: boolean;
  execute(input: WorkspaceCommandProcessInput): Promise<ProcessResult>;
  /**
   * Removes what commands left running whose id starts with `idPrefix` and that were started
   * longer ago than `olderThanMs`: a worker that was killed could not end them. Answers how
   * many it removed. A sandbox whose commands end with the worker has nothing to remove.
   */
  removeLeftovers?(input: { idPrefix: string; olderThanMs: number }): Promise<number>;
}

export class LocalWorkspaceCommandProcessExecutor implements WorkspaceCommandProcessExecutor {
  constructor(private readonly options: { shellPath?: string } = {}) {}

  async execute(input: WorkspaceCommandProcessInput): Promise<ProcessResult> {
    await mkdir(input.tempDirectory, { recursive: true });
    return runSpawnedProcess({
      executable: this.options.shellPath ?? DEFAULT_WORKSPACE_COMMAND_SHELL,
      args: ["-c", input.command.command],
      cwd: input.cwd,
      env: input.env,
      timeoutSeconds: input.command.limits.timeoutSeconds,
      idleTimeoutSeconds: input.command.limits.idleTimeoutSeconds,
      maxStdoutBytes: input.command.limits.maxStdoutBytes,
      maxStderrBytes: input.command.limits.maxStderrBytes,
      signal: input.signal,
      ...(input.requests ? { requests: input.requests } : {})
    });
  }
}

/**
 * How long the streams of a process may stay open after the process ended. Only a process it
 * started that left its process group can hold them longer; the result does not wait for it.
 */
const STREAMS_AFTER_EXIT_MS = 1_000;

/**
 * Runs one process in a process group of its own. When the process ends, for any reason,
 * every process still in its group is killed: nothing it started in the background outlives
 * it there. A process that left the group, with `setsid` or a double fork, is out of reach of
 * this; only a sandbox of its own, such as the PID namespace of a container, ends that one.
 */
export async function runSpawnedProcess(input: {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds: number;
  idleTimeoutSeconds?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  onTerminate?: () => Promise<void> | void;
  /** Requests the process writes before its output, each answered on its input stream. */
  requests?: SandboxRequestChannel;
}): Promise<ProcessResult> {
  if (input.signal?.aborted) {
    return cancelledProcessResult(Date.now(), input.signal.reason);
  }

  const stdout = new BoundedOutput(input.maxStdoutBytes ?? 64 * 1024);
  const stderr = new BoundedOutput(input.maxStderrBytes ?? 64 * 1024);
  const startedAt = Date.now();

  return new Promise((resolvePromise) => {
    let settled = false;
    let timeoutKind: ProcessResult["timeoutKind"];
    let spawnError: Error | undefined;
    let cancelled = false;
    let cancellationReason: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let streamsTimer: NodeJS.Timeout | undefined;
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      detached: true,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    // A process that ended, or closed its input, is answered nothing more. One without
    // requests reads nothing on its input stream.
    child.stdin.on("error", () => undefined);
    if (!input.requests) child.stdin.end();
    // The process's output is read one request at a time: while a request is answered, its
    // output stream is paused, so a process that writes requests faster than they are answered
    // waits, and so does one that reads no answers.
    const requests = input.requests
      ? new RequestLines(input.requests, {
          reply: (line) => writeLine(child.stdin, line),
          pause: () => child.stdout.pause(),
          resume: () => child.stdout.resume(),
          close: () => child.stdin.end(),
          output: (chunk) => stdout.append(chunk),
          answering: (busy) => {
            // A process waits for its answer: that is no idleness, and it is not counted.
            if (busy) clearTimeout(idleTimer);
            else resetIdleTimer();
          }
        })
      : undefined;

    const cleanupAbortListener = () => {
      input.signal?.removeEventListener("abort", abort);
    };
    const finish = (exitCode: number, signal?: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupAbortListener();
      clearTimeout(wallTimer);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      clearTimeout(streamsTimer);
      resolvePromise({
        exitCode: cancelled ? 130 : timeoutKind ? 124 : exitCodeFromProcess(exitCode, signal),
        stdoutPreview: stdout.text(),
        stderrPreview: stderr.text(),
        truncated: {
          stdout: stdout.truncated,
          stderr: stderr.truncated
        },
        durationMs: Date.now() - startedAt,
        timeoutKind,
        cancelled,
        cancellationReason,
        spawnError
      });
    };
    const terminate = (kind: NonNullable<ProcessResult["timeoutKind"]>) => {
      if (settled || timeoutKind || cancelled) {
        return;
      }
      timeoutKind = kind;
      void input.onTerminate?.();
      terminateProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 500);
    };
    function abort() {
      if (settled || cancelled) {
        return;
      }
      cancelled = true;
      cancellationReason = stringifyAbortReason(input.signal?.reason);
      void input.onTerminate?.();
      terminateProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 500);
    }
    const resetIdleTimer = () => {
      if (!input.idleTimeoutSeconds || settled || timeoutKind || cancelled) {
        return;
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate("idle"), input.idleTimeoutSeconds * 1000);
    };
    const wallTimer = setTimeout(() => terminate("wall"), input.timeoutSeconds * 1000);
    resetIdleTimer();
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (!requests) {
        stdout.append(chunk);
        resetIdleTimer();
        return;
      }
      // Only output after the end mark shows the process at work: requests never put the idle
      // timeout off, and the wall timeout bounds them.
      if (requests.take(chunk)) resetIdleTimer();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      resetIdleTimer();
    });
    child.on("error", (error) => {
      spawnError = error;
      finish(127);
    });
    child.on("exit", (code, signal) => {
      // What the process left running in its group ends with it, whether it ended by itself,
      // at a timeout or at a cancel.
      clearTimeout(wallTimer);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      terminateProcessGroup(child, "SIGKILL");
      streamsTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code ?? 1, signal);
      }, STREAMS_AFTER_EXIT_MS);
    });
    child.on("close", (code, signal) => {
      finish(code ?? 1, signal);
    });
  });
}

/** Writes one line, and waits while the stream holds more than it takes. */
function writeLine(stream: NodeJS.WritableStream & { writable: boolean }, line: string) {
  return new Promise<void>((resolve) => {
    if (!stream.writable) {
      resolve();
      return;
    }
    if (stream.write(`${line}\n`)) {
      resolve();
      return;
    }
    const done = () => {
      stream.off("drain", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.on("drain", done);
    stream.on("close", done);
    stream.on("error", done);
  });
}

/** What the request lines of a process act on. */
interface RequestLinesIo {
  reply(line: string): Promise<void>;
  pause(): void;
  resume(): void;
  /** Closes the process's input stream: it is answered nothing more. */
  close(): void;
  output(chunk: Buffer): void;
  answering(busy: boolean): void;
}

/**
 * Reads the requests of a process from its output stream until the end mark and answers each,
 * one at a time: while one is answered the stream is paused, and the rest of the chunk waits.
 * What follows the mark is the process's own output. Past `maxLines` lines, or once the
 * requests passed `maxLines` lines of `maxLineBytes`, the channel is closed and nothing more is
 * held but the line being read, to find the mark.
 */
class RequestLines {
  private held: Buffer[] = [];
  private heldBytes = 0;
  /** The line being read is longer than a request may be: the rest of it is dropped. */
  private dropping = false;
  private ended = false;
  private closed = false;
  private lines = 0;
  /** The bytes read before the end mark, and the most of them read. */
  private bytes = 0;
  private readonly maxBytes: number;
  /** The rest of a chunk while its request is answered. */
  private waiting: Buffer | undefined;

  constructor(
    private readonly channel: SandboxRequestChannel,
    private readonly io: RequestLinesIo
  ) {
    this.maxBytes = channel.maxLines * (channel.maxLineBytes + 1);
  }

  /** Reads a chunk. Whether it held output: bytes after the end mark. */
  take(chunk: Buffer): boolean {
    if (this.waiting) {
      // A chunk the stream had read before it paused.
      this.waiting = Buffer.concat([this.waiting, chunk]);
      return false;
    }
    return this.read(chunk);
  }

  private read(chunk: Buffer): boolean {
    if (this.ended) {
      this.io.output(chunk);
      return chunk.byteLength > 0;
    }
    let start = 0;
    while (start < chunk.byteLength) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.byteLength : newline;
      this.hold(chunk.subarray(start, end));
      if (newline === -1) {
        this.counted(end - start);
        return false;
      }
      this.counted(end - start + 1);
      start = newline + 1;
      const line = this.line();
      if (line === this.channel.endMark) {
        this.ended = true;
        const rest = chunk.subarray(start);
        if (rest.byteLength > 0) this.io.output(rest);
        return rest.byteLength > 0;
      }
      if (this.closed || line === "") continue;
      this.lines += 1;
      if (this.lines > this.channel.maxLines) {
        this.close();
        continue;
      }
      this.answer(
        line === undefined
          ? Promise.resolve(this.channel.refuse("too_long"))
          : this.channel.answer(line),
        chunk.subarray(start)
      );
      return false;
    }
    return false;
  }

  /** Answers one request, then reads on from `rest`. */
  private answer(answer: Promise<string>, rest: Buffer): void {
    this.waiting = rest;
    this.io.pause();
    this.io.answering(true);
    const next = () => {
      this.io.answering(false);
      const rest = this.waiting ?? Buffer.alloc(0);
      this.waiting = undefined;
      this.read(rest);
      if (this.waiting === undefined) this.io.resume();
    };
    answer
      .then((text) => this.io.reply(text))
      .then(next, next)
      .catch(() => undefined);
  }

  private counted(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.maxBytes && !this.closed) this.close();
  }

  private close(): void {
    this.closed = true;
    this.io.close();
  }

  private hold(part: Buffer): void {
    if (this.dropping) return;
    if (this.heldBytes + part.byteLength > this.channel.maxLineBytes) {
      this.dropping = true;
      this.held = [];
      this.heldBytes = 0;
      return;
    }
    this.held.push(part);
    this.heldBytes += part.byteLength;
  }

  /** The line read, or nothing where it was dropped. */
  private line(): string | undefined {
    if (this.dropping) {
      this.dropping = false;
      return undefined;
    }
    const text = Buffer.concat(this.held, this.heldBytes).toString("utf8");
    this.held = [];
    this.heldBytes = 0;
    return text;
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

function cancelledProcessResult(startedAt: number, reason: unknown): ProcessResult {
  return {
    exitCode: 130,
    stdoutPreview: "",
    stderrPreview: "",
    truncated: {
      stdout: false,
      stderr: false
    },
    durationMs: Date.now() - startedAt,
    cancelled: true,
    cancellationReason: stringifyAbortReason(reason)
  };
}

function stringifyAbortReason(reason: unknown): string | undefined {
  if (typeof reason === "string") {
    return reason;
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  return undefined;
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

function exitCodeFromProcess(exitCode: number, signal?: NodeJS.Signals | null): number {
  if (exitCode !== null && exitCode !== undefined) {
    return exitCode;
  }
  if (!signal) {
    return 1;
  }
  return 128 + signalNumber(signal);
}

function signalNumber(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGHUP":
      return 1;
    case "SIGINT":
      return 2;
    case "SIGTERM":
      return 15;
    case "SIGKILL":
      return 9;
    default:
      return 1;
  }
}

declare module "@work-shape/catalyst-core" {
  /** What the `sandbox` port creates. */
  interface ProviderInstances {
    sandbox: WorkspaceCommandProcessExecutor;
  }
}
