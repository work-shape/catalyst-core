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
    options?: ErrorOptions,
    readonly signal?: NodeJS.Signals
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
    child.on("close", (code, signal) => {
      if (settled) return;
      finish();
      const errorText = stderr.toString("utf8").trim();
      if (forcedFailure)
        reject(
          new NativeProcessError(
            forcedFailure,
            input.command,
            errorText,
            code ?? undefined,
            undefined,
            signal ?? undefined
          )
        );
      else if (code !== 0) {
        reject(
          new NativeProcessError(
            "process_failed",
            input.command,
            errorText,
            code ?? undefined,
            undefined,
            signal ?? undefined
          )
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

export type PdfPageImageFormat = { type: "png" } | { type: "jpeg"; qualityPercent: number };

export type PdfPageResolution = { dpi?: number; maxLongEdgePixels?: number };

// The image of a page, slide or sheet that a model reads is encoded for the model, not for a
// person: JPEG with its long edge at most this many pixels. Measured on 2026-10-10 on six
// synthetic pages (contract with 7 pt and 6 pt print, clean and rough colour scan of it, 6.5 pt
// table, slide, spreadsheet): at 1568 px and quality 80 gpt-5.5 read all 38 seeded values, at
// 1280 px it misread two digits in the 6 pt footnote of the rough scan. A page then weighs 0.06
// to 0.45 MB (text page 0.32, rough scan 0.45) where the 160 DPI PNG weighed 0.08 to 5.4 MB.
// A reader who needs more asks view_document_page for 200 DPI.
export const MODEL_PAGE_IMAGE_MAX_LONG_EDGE_PIXELS = 1568;
export const MODEL_PAGE_IMAGE_JPEG_QUALITY_PERCENT = 80;
export const MODEL_PAGE_IMAGE_MIME_TYPE = "image/jpeg";
export const MODEL_PAGE_IMAGE_FORMAT: PdfPageImageFormat = {
  type: "jpeg",
  qualityPercent: MODEL_PAGE_IMAGE_JPEG_QUALITY_PERCENT
};

/**
 * The resolution to render a page at: the wanted DPI, or the long-edge limit where that DPI would
 * pass it. A page is never scaled up to the limit.
 */
export function boundedPdfPageResolution(input: {
  pageSize: { widthPoints: number; heightPoints: number };
  dpi: number;
  maxLongEdgePixels: number;
}): PdfPageResolution {
  const longEdgePixels =
    (Math.max(input.pageSize.widthPoints, input.pageSize.heightPoints) * input.dpi) / 72;
  return longEdgePixels > input.maxLongEdgePixels
    ? { maxLongEdgePixels: input.maxLongEdgePixels }
    : { dpi: input.dpi };
}

export async function renderPdfPage(
  input: NativeCommandInput & {
    pdfPath: string;
    outputDirectory: string;
    pageNumber: number;
    resolution: PdfPageResolution;
    /** PNG unless stated. */
    format?: PdfPageImageFormat;
  }
): Promise<Uint8Array> {
  const operationOutput = await mkdtemp(join(input.outputDirectory, ".catalyst-pdf-render-"));
  const prefix = join(operationOutput, `page-${input.pageNumber}`);
  const format = input.format ?? { type: "png" };
  const output = `${prefix}.${format.type === "jpeg" ? "jpg" : "png"}`;
  try {
    await runNativeProcess({
      command: input.command,
      args: [
        ...(format.type === "jpeg"
          ? ["-jpeg", "-jpegopt", `quality=${format.qualityPercent}`]
          : ["-png"]),
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
