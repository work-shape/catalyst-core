import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type NativeProcessFailure = "aborted" | "command_missing" | "process_failed" | "timeout";

interface NativeCommandInput {
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export class NativeProcessError extends Error {
  override readonly name = "NativeProcessError";
  constructor(
    readonly reason: NativeProcessFailure,
    readonly command: string,
    readonly stderr = "",
    readonly exitCode?: number,
    options?: ErrorOptions
  ) {
    super(
      stderr ||
        (options?.cause instanceof Error ? options.cause.message : undefined) ||
        `Native command '${command}' failed: ${reason}`,
      options
    );
  }
}

export async function runNativeProcess(
  input: NativeCommandInput & {
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
  }
): Promise<{ stdout: string; stderr: string }> {
  if (input.signal?.aborted) throw new NativeProcessError("aborted", input.command);
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const limit = 64 * 1024;
    let child: ChildProcess;
    try {
      child = spawn(input.command, [...input.args], {
        detached,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(processError(input.command, error));
      return;
    }

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let forcedFailure: "aborted" | "timeout" | undefined;
    let settled = false;
    const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);
    const onAbort = () => terminate("aborted");
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = () => {
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    };
    function terminate(reason: "aborted" | "timeout") {
      if (settled || forcedFailure) return;
      forcedFailure = reason;
      kill(child, "SIGKILL");
    }

    child.stdout?.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk, limit)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk, limit)));
    child.on("error", (error) => {
      if (settled) return;
      finish();
      reject(processError(input.command, error));
    });
    child.on("close", (code) => {
      if (settled) return;
      finish();
      const errorText = stderr.toString("utf8").trim();
      if (forcedFailure) reject(new NativeProcessError(forcedFailure, input.command, errorText));
      else if (code !== 0) {
        reject(
          new NativeProcessError("process_failed", input.command, errorText, code ?? undefined)
        );
      } else resolve({ stdout: stdout.toString("utf8"), stderr: errorText });
    });
  });
}

export async function convertOfficeDocument(
  input: NativeCommandInput & {
    sourcePath: string;
    outputDirectory: string;
    outputFormat: "odt" | "pdf";
  }
): Promise<{ outputPath?: string; stdout: string }> {
  const operation = await mkdtemp(join(input.outputDirectory, ".catalyst-office-operation-"));
  const profile = join(operation, ".catalyst-office-profile-");
  const operationOutput = join(operation, "output");
  try {
    await Promise.all([mkdir(profile), mkdir(operationOutput)]);
    const { stdout } = await runNativeProcess({
      command: input.command,
      args: [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless",
        "--nofirststartwizard",
        "--norestore",
        "--convert-to",
        input.outputFormat,
        "--outdir",
        operationOutput,
        input.sourcePath
      ],
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      env: officeEnvironment(profile)
    });
    const converted = await convertedFile(
      operationOutput,
      input.sourcePath,
      `.${input.outputFormat}`
    );
    if (!converted) return { stdout };
    const outputPath = join(input.outputDirectory, basename(converted));
    await copyFile(converted, outputPath);
    return { stdout, outputPath };
  } finally {
    await rm(operation, { force: true, recursive: true });
  }
}

export async function inspectPdf(
  input: NativeCommandInput & {
    pdfPath: string;
    pageNumber?: number;
  }
): Promise<{
  pageCount?: number;
  pageSize?: { widthPoints: number; heightPoints: number };
}> {
  const page = input.pageNumber
    ? ["-f", String(input.pageNumber), "-l", String(input.pageNumber)]
    : [];
  const { stdout } = await runNativeProcess({
    command: input.command,
    args: [...page, input.pdfPath],
    timeoutMs: input.timeoutMs,
    signal: input.signal
  });
  const pageCount = Number(/^Pages:\s+(\d+)\s*$/imu.exec(stdout)?.[1]);
  const size = /^(?:Page\s+\d+\s+size|Page size):\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts\b/mu.exec(
    stdout
  );
  const widthPoints = Number(size?.[1]);
  const heightPoints = Number(size?.[2]);
  return {
    ...(pageCount > 0 ? { pageCount } : {}),
    ...(widthPoints > 0 && heightPoints > 0 ? { pageSize: { widthPoints, heightPoints } } : {})
  };
}

export async function renderPdfPage(
  input: NativeCommandInput & {
    pdfPath: string;
    outputDirectory: string;
    pageNumber: number;
    resolution: { dpi?: number; maxLongEdgePixels?: number };
  }
): Promise<Uint8Array> {
  const operationOutput = await mkdtemp(join(input.outputDirectory, ".catalyst-pdf-render-"));
  const prefix = join(operationOutput, `page-${input.pageNumber}`);
  const output = `${prefix}.png`;
  try {
    await runNativeProcess({
      command: input.command,
      args: [
        "-png",
        "-singlefile",
        ...(input.resolution.dpi ? ["-r", String(input.resolution.dpi)] : []),
        ...(input.resolution.maxLongEdgePixels
          ? ["-scale-to", String(input.resolution.maxLongEdgePixels)]
          : []),
        "-f",
        String(input.pageNumber),
        "-l",
        String(input.pageNumber),
        input.pdfPath,
        prefix
      ],
      timeoutMs: input.timeoutMs,
      signal: input.signal
    });
    return await readFile(output);
  } finally {
    await rm(operationOutput, { force: true, recursive: true });
  }
}

function processError(command: string, cause: unknown): NativeProcessError {
  const reason =
    cause instanceof Error && "code" in cause && (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? "command_missing"
      : "process_failed";
  return new NativeProcessError(reason, command, "", undefined, { cause });
}

function append(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (limit <= 0) return Buffer.alloc(0);
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= limit ? combined : combined.subarray(-limit);
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

function officeEnvironment(profile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: profile,
    XDG_CONFIG_HOME: join(profile, "xdg_config"),
    XDG_CACHE_HOME: join(profile, "xdg_cache")
  };
  if (process.platform === "darwin") env.TMPDIR = env.TEMP = env.TMP = "/private/tmp";
  return env;
}

async function convertedFile(directory: string, sourcePath: string, extension: ".odt" | ".pdf") {
  const exact = `${basename(sourcePath, extname(sourcePath))}${extension}`;
  const matches = (await readdir(directory))
    .filter((file) => file.toLowerCase().endsWith(extension))
    .sort((left, right) => (left === exact ? -1 : right === exact ? 1 : left.localeCompare(right)));
  for (const file of matches) {
    const path = join(directory, file);
    const info = await stat(path);
    if (info.isFile() && info.size > 0) return path;
  }
  return undefined;
}
