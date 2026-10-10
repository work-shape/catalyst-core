import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_BUILD_MAX_OUTPUT_BYTES } from "./bundle";
import type { PageBuildError, PageBuildErrorCode, PageBuildResult, PageFile } from "./types";
import { decodeWireMessage, encodeWireMessage } from "./wire";

// One build runs in one process of its own, started here and ended here. The files of a Page
// are untrusted input to parsers, so the work on them is kept out of the worker process: a
// build that hangs or grows is ended without the worker and its other jobs noticing.
//
// The process gets nothing of the worker's environment: no variable of it is passed on, so no
// secret of the instance is in its memory. It gets a temporary directory of its own as working
// directory and as the place for temporary files, which is removed when it ended, however it
// ended.

/** How long one build may take. After it the process is killed and the save fails. */
export const PAGE_BUILD_TIMEOUT_MS = 60_000;
/** The heap of the build process, in megabytes. A build that needs more ends itself. */
export const PAGE_BUILD_MAX_HEAP_MB = 1024;
/** How much of what a build process wrote as an error is kept for the log. */
const PAGE_BUILD_STDERR_CHARS = 4000;
/** Room for the head of the result message beside the bytes of the built files. */
const RESULT_HEAD_ALLOWANCE_BYTES = 1024 * 1024;

export interface PageBuildLimits {
  timeoutMs: number;
  maxHeapMb: number;
  maxOutputBytes: number;
}

export const DEFAULT_PAGE_BUILD_LIMITS: PageBuildLimits = {
  timeoutMs: PAGE_BUILD_TIMEOUT_MS,
  maxHeapMb: PAGE_BUILD_MAX_HEAP_MB,
  maxOutputBytes: PAGE_BUILD_MAX_OUTPUT_BYTES
};

/** Why a build gave no result that is about the Page's files. */
export type PageBuildFailure = "timeout" | "output_too_large" | "crashed" | "stopped";

export type PageBuildOutcome =
  | PageBuildResult
  | {
      status: "failed";
      reason: PageBuildFailure;
      message: string;
      /** What the process wrote as an error, for the log of the worker. Never shown. */
      detail?: string;
    };

export interface RunPageBuildInput {
  files: readonly PageFile[];
  /** Aborting it kills the build process. */
  signal?: AbortSignal;
  limits?: Partial<PageBuildLimits>;
  /** The script of the build process. For tests; otherwise the one this package ships. */
  processEntry?: string;
}

/** Builds a Page in a process of its own and waits for it. It never rejects for a failed build. */
export async function runPageBuild(input: RunPageBuildInput): Promise<PageBuildOutcome> {
  const limits = { ...DEFAULT_PAGE_BUILD_LIMITS, ...input.limits };
  if (input.signal?.aborted) {
    return { status: "failed", reason: "stopped", message: "The build was stopped." };
  }
  const directory = await mkdtemp(join(tmpdir(), "catalyst-page-build-"));
  try {
    return await runInProcess(input, limits, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runInProcess(
  input: RunPageBuildInput,
  limits: PageBuildLimits,
  directory: string
): Promise<PageBuildOutcome> {
  return new Promise((settle) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${limits.maxHeapMb}`, input.processEntry ?? pageBuildProcessEntry()],
      {
        cwd: directory,
        // Nothing of this process's environment. The temporary directory is the build's own.
        env: { TMPDIR: directory, TEMP: directory, TMP: directory },
        stdio: ["pipe", "pipe", "pipe"],
        // A process group of its own, so that ending the build ends esbuild's process with it.
        detached: process.platform !== "win32",
        windowsHide: true
      }
    );
    const output: Buffer[] = [];
    let outputBytes = 0;
    let stderr = "";
    let failure: { reason: PageBuildFailure; message: string } | undefined;

    const kill = (reason: PageBuildFailure, message: string) => {
      failure ??= { reason, message };
      try {
        if (child.pid !== undefined && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // The process has ended already.
      }
    };
    const timer = setTimeout(
      () =>
        kill(
          "timeout",
          `The build did not finish within ${Math.round(limits.timeoutMs / 1000)} seconds and was stopped.`
        ),
      limits.timeoutMs
    );
    const onAbort = () => kill("stopped", "The build was stopped.");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > limits.maxOutputBytes + RESULT_HEAD_ALLOWANCE_BYTES) {
        kill(
          "output_too_large",
          `The build produced more than ${limits.maxOutputBytes} bytes and was stopped.`
        );
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-PAGE_BUILD_STDERR_CHARS);
    });
    // A process that ended early closes its input; what counts is how it ended.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      failure ??= { reason: "crashed", message: "The build process could not be started." };
      stderr = error.message;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (failure) {
        settle({ status: "failed", ...failure, ...(stderr ? { detail: stderr } : {}) });
        return;
      }
      if (code !== 0) {
        settle({
          status: "failed",
          reason: "crashed",
          message: `The build process ended without a result (${signal ?? `exit code ${code}`}). A build that needs more than ${limits.maxHeapMb} MB of memory ends this way.`,
          ...(stderr ? { detail: stderr } : {})
        });
        return;
      }
      try {
        settle(readResult(Buffer.concat(output)));
      } catch (error) {
        settle({
          status: "failed",
          reason: "crashed",
          message: "The build process gave a result that cannot be read.",
          detail: error instanceof Error ? error.message : String(error)
        });
      }
    });

    for (const part of encodeWireMessage({
      head: { paths: input.files.map((file) => file.path) },
      blobs: input.files.map((file) => file.bytes)
    })) {
      child.stdin.write(part);
    }
    child.stdin.end();
  });
}

/** The result as the build process wrote it, checked field by field. */
function readResult(bytes: Uint8Array): PageBuildResult {
  const { head, blobs } = decodeWireMessage(bytes);
  if (typeof head !== "object" || head === null || !("status" in head)) {
    throw new Error("The result has no status");
  }
  if (head.status === "errors" && "errors" in head && Array.isArray(head.errors)) {
    return { status: "errors", errors: head.errors.map(readError) };
  }
  if (
    head.status === "built" &&
    "kitVersion" in head &&
    typeof head.kitVersion === "string" &&
    "manifest" in head &&
    isRecord(head.manifest) &&
    "paths" in head &&
    Array.isArray(head.paths) &&
    head.paths.length === blobs.length
  ) {
    return {
      status: "built",
      kitVersion: head.kitVersion,
      manifest: head.manifest,
      files: head.paths.map((path, index) => {
        if (typeof path !== "string") throw new Error("A path of the result is not a text");
        return { path, bytes: blobs[index] ?? new Uint8Array() };
      })
    };
  }
  throw new Error("The result is neither built files nor errors");
}

function readError(value: unknown): PageBuildError {
  if (!isRecord(value) || typeof value.file !== "string" || typeof value.message !== "string") {
    throw new Error("An error of the result has no file or no message");
  }
  return {
    file: value.file,
    message: value.message,
    ...(typeof value.line === "number" ? { line: value.line } : {}),
    ...(typeof value.column === "number" ? { column: value.column } : {}),
    ...(typeof value.element === "string" ? { element: value.element } : {}),
    ...(typeof value.attribute === "string" ? { attribute: value.attribute } : {}),
    ...(isErrorCode(value.code) ? { code: value.code } : {})
  };
}

const ERROR_CODES: readonly PageBuildErrorCode[] = [
  "manifest_invalid",
  "file_invalid",
  "inline_event_handler",
  "external_resource",
  "import_unavailable",
  "syntax",
  "routes_invalid",
  "output_too_large"
];

function isErrorCode(value: unknown): value is PageBuildErrorCode {
  return ERROR_CODES.some((code) => code === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The script of the build process as this package ships it: `dist/build-process.js`, found
 * from the built package and from its sources alike.
 */
export function pageBuildProcessEntry(): string {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/build-process.js");
  if (!existsSync(entry)) {
    throw new Error(
      `The Page build process is missing at ${entry}. Build the package @vivd-catalyst/app-build.`
    );
  }
  return entry;
}
