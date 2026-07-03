import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { WorkspaceCommand } from "@vivd-catalyst/core";

export const DEFAULT_WORKSPACE_COMMAND_PATH =
  "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const DEFAULT_WORKSPACE_COMMAND_SHELL = "/bin/bash";

export interface WorkspaceCommandProcessInput {
  command: WorkspaceCommand;
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
}

export interface WorkspaceCommandProcessExecutor {
  execute(input: WorkspaceCommandProcessInput): Promise<ProcessResult>;
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
      signal: input.signal
    });
  }
}

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
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      detached: true,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

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
