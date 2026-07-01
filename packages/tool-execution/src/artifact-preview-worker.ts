import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import {
  AppError,
  detectArtifactPreviewSourceKind,
  type ArtifactPreviewImageArtifactInput,
  type ArtifactPreviewFailureCode,
  type ArtifactPreviewImageFormat,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewSourceKind,
  type ClientInstanceId,
  type ManagedArtifactRecord,
  type PlatformStore
} from "@vivd-catalyst/core";
import type { DeletableWorkspaceObjectStorage } from "./workspace-file-bytes";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_STALE_RECOVERY_INTERVAL_MS = 30000;
const DEFAULT_STALE_RECOVERY_LIMIT = 50;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 0;
const DEFAULT_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 40;
const HARD_MAX_PAGES = 80;
const DEFAULT_CONVERSION_TIMEOUT_MS = 60000;
const DEFAULT_RASTERIZATION_TIMEOUT_MS = 60000;
const DEFAULT_PREVIEW_DPI = 144;
const DEFAULT_OUTPUT_FORMAT: ArtifactPreviewImageFormat = "png";

export type ArtifactPreviewWorkerStore = Pick<
  PlatformStore,
  | "claimNextArtifactPreviewJob"
  | "completeClaimedArtifactPreviewJob"
  | "failClaimedArtifactPreviewJob"
  | "getManagedArtifact"
  | "markClaimedArtifactPreviewJobUnsupported"
  | "recoverStaleArtifactPreviewJobs"
>;

export interface ArtifactPreviewWorkerOptions {
  clientInstanceId: ClientInstanceId;
  store: ArtifactPreviewWorkerStore;
  objectStore: DeletableWorkspaceObjectStorage;
  renderer?: ArtifactPreviewRenderer;
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  staleRecoveryIntervalMs?: number;
  staleRecoveryLimit?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxSourceBytes?: number;
  maxPages?: number;
  conversionTimeoutMs?: number;
  rasterizationTimeoutMs?: number;
  previewDpi?: number;
  outputFormat?: ArtifactPreviewImageFormat;
  now?: () => string;
}

export type ArtifactPreviewWorkerRunOnceResult =
  | { status: "idle" }
  | { status: "claimed"; job: ArtifactPreviewJobRecord }
  | { status: "stale"; job: ArtifactPreviewJobRecord };

export interface ArtifactPreviewRenderInput {
  sourceKind: ArtifactPreviewSourceKind;
  filename?: string;
  mimeType: string;
  bytes: Uint8Array;
  maxPages: number;
  previewDpi: number;
  outputFormat: ArtifactPreviewImageFormat;
  conversionTimeoutMs: number;
  rasterizationTimeoutMs: number;
  signal?: AbortSignal;
}

export interface ArtifactPreviewRenderedPage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  pageNumber?: number;
  slideNumber?: number;
  width?: number;
  height?: number;
}

export interface ArtifactPreviewRenderResult {
  format: ArtifactPreviewImageFormat;
  pages: ArtifactPreviewRenderedPage[];
}

export interface ArtifactPreviewRenderer {
  render(input: ArtifactPreviewRenderInput): Promise<ArtifactPreviewRenderResult>;
}

export class ArtifactPreviewWorker {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly store: ArtifactPreviewWorkerStore;
  private readonly objectStore: DeletableWorkspaceObjectStorage;
  private readonly renderer: ArtifactPreviewRenderer;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly staleRecoveryIntervalMs: number;
  private readonly staleRecoveryLimit: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxSourceBytes: number;
  private readonly maxPages: number;
  private readonly conversionTimeoutMs: number;
  private readonly rasterizationTimeoutMs: number;
  private readonly previewDpi: number;
  private readonly outputFormat: ArtifactPreviewImageFormat;
  private readonly now: () => string;
  private readonly activeControllers = new Set<AbortController>();
  private stopping = false;
  private loopPromise?: Promise<void>;
  private lastStaleRecoveryMs = 0;

  constructor(options: ArtifactPreviewWorkerOptions) {
    this.clientInstanceId = options.clientInstanceId;
    this.store = options.store;
    this.objectStore = options.objectStore;
    this.renderer = options.renderer ?? new LibreOfficeArtifactPreviewRenderer();
    this.workerId = options.workerId ?? `artifact-preview-worker-${randomUUID()}`;
    this.concurrency = options.concurrency ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.staleRecoveryIntervalMs =
      options.staleRecoveryIntervalMs ?? DEFAULT_STALE_RECOVERY_INTERVAL_MS;
    this.staleRecoveryLimit = options.staleRecoveryLimit ?? DEFAULT_STALE_RECOVERY_LIMIT;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    this.maxPages = Math.min(options.maxPages ?? DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
    this.conversionTimeoutMs = options.conversionTimeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS;
    this.rasterizationTimeoutMs = options.rasterizationTimeoutMs ?? DEFAULT_RASTERIZATION_TIMEOUT_MS;
    this.previewDpi = options.previewDpi ?? DEFAULT_PREVIEW_DPI;
    this.outputFormat = options.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runOnce(input: { recoverStale?: boolean } = {}): Promise<ArtifactPreviewWorkerRunOnceResult> {
    if (input.recoverStale ?? true) {
      await this.recoverStaleJobs();
    }
    const now = this.now();
    const claimed = await this.store.claimNextArtifactPreviewJob({
      clientInstanceId: this.clientInstanceId,
      workerId: this.workerId,
      leaseToken: randomUUID(),
      now,
      leaseExpiresAt: addMilliseconds(now, this.leaseDurationMs)
    });
    if (!claimed) {
      return { status: "idle" };
    }
    return this.processClaimedJob(claimed);
  }

  async recoverStaleJobs(): Promise<ArtifactPreviewJobRecord[]> {
    const now = this.now();
    this.lastStaleRecoveryMs = Date.now();
    return this.store.recoverStaleArtifactPreviewJobs({
      clientInstanceId: this.clientInstanceId,
      staleLeaseExpiredBefore: now,
      recoveredAt: now,
      retryAt: addMilliseconds(now, this.retryDelayMs),
      maxAttempts: this.maxAttempts,
      limit: this.staleRecoveryLimit,
      errorCode: "stale_lease",
      errorMessage: previewFailureMessage("stale_lease")
    });
  }

  start(): Promise<void> {
    if (!this.loopPromise) {
      this.stopping = false;
      this.loopPromise = Promise.all(
        Array.from({ length: this.concurrency }, (_, index) => this.runLoop(index))
      ).then(() => undefined);
    }
    return this.loopPromise;
  }

  runUntilStopped(): Promise<void> {
    return this.start();
  }

  async stop(input: { cancelActive?: boolean; reason?: string } = {}): Promise<void> {
    this.stopping = true;
    if (input.cancelActive) {
      for (const controller of this.activeControllers) {
        controller.abort(input.reason ?? "Artifact preview worker is stopping");
      }
    }
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async runLoop(index: number): Promise<void> {
    while (!this.stopping) {
      await this.maybeRecoverStaleJobs();
      const result = await this.runOnce({ recoverStale: false });
      if (result.status === "idle") {
        await sleep(this.pollIntervalMs);
      }
    }
    void index;
  }

  private async maybeRecoverStaleJobs(): Promise<void> {
    if (Date.now() - this.lastStaleRecoveryMs < this.staleRecoveryIntervalMs) {
      return;
    }
    await this.recoverStaleJobs();
  }

  private async processClaimedJob(
    job: ArtifactPreviewJobRecord
  ): Promise<ArtifactPreviewWorkerRunOnceResult> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      const terminal = await this.processClaimedJobWithSignal(job, controller.signal);
      return { status: "claimed", job: terminal };
    } catch (error: unknown) {
      if (isLeaseConflict(error)) {
        return { status: "stale", job };
      }
      const failure = normalizePreviewFailure(error);
      try {
        const terminal =
          failure.code === "unsupported_type"
            ? await this.markUnsupported(job)
            : await this.failClaimedJob(job, failure);
        return { status: "claimed", job: terminal };
      } catch (terminalError: unknown) {
        if (isLeaseConflict(terminalError)) {
          return { status: "stale", job };
        }
        throw terminalError;
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  private async processClaimedJobWithSignal(
    job: ArtifactPreviewJobRecord,
    signal: AbortSignal
  ): Promise<ArtifactPreviewJobRecord> {
    const source = await this.store.getManagedArtifact({
      clientInstanceId: job.clientInstanceId,
      artifactId: job.sourceArtifactId
    });
    if (!source || source.conversationId !== job.conversationId || source.checksum !== job.sourceChecksum) {
      return this.failClaimedJob(job, previewFailure("source_missing", false));
    }

    const sourceKind = detectArtifactPreviewSourceKind(source);
    if (!sourceKind) {
      return this.markUnsupported(job);
    }
    if (source.byteSize > this.maxSourceBytes) {
      return this.failClaimedJob(job, previewFailure("source_too_large", false));
    }

    const sourceBytes = await this.readSourceBytes(source);
    if (sourceBytes.byteLength > this.maxSourceBytes) {
      return this.failClaimedJob(job, previewFailure("source_too_large", false));
    }

    const rendered = await this.renderer.render({
      sourceKind,
      filename: source.filename,
      mimeType: source.mimeType,
      bytes: sourceBytes,
      maxPages: this.maxPages,
      previewDpi: this.previewDpi,
      outputFormat: this.outputFormat,
      conversionTimeoutMs: this.conversionTimeoutMs,
      rasterizationTimeoutMs: this.rasterizationTimeoutMs,
      signal
    });
    if (rendered.pages.length === 0 || rendered.pages.length > this.maxPages) {
      return this.failClaimedJob(job, previewFailure("page_limit_exceeded", false));
    }

    const staged = await this.stageRenderedPages({
      job,
      source,
      sourceKind,
      rendered
    });
    try {
      return await this.store.completeClaimedArtifactPreviewJob({
        clientInstanceId: job.clientInstanceId,
        jobId: job.id,
        leaseToken: requiredLeaseToken(job),
        format: rendered.format,
        previewArtifacts: staged.previewArtifacts,
        completedAt: this.now()
      });
    } catch (error: unknown) {
      await this.deleteStagedObjects(staged.objectKeys);
      throw error;
    }
  }

  private async readSourceBytes(source: ManagedArtifactRecord): Promise<Uint8Array> {
    try {
      return await this.objectStore.getObject(source.objectKey);
    } catch {
      throw previewFailure("source_missing", false);
    }
  }

  private async stageRenderedPages(input: {
    job: ArtifactPreviewJobRecord;
    source: ManagedArtifactRecord;
    sourceKind: ArtifactPreviewSourceKind;
    rendered: ArtifactPreviewRenderResult;
  }): Promise<{ previewArtifacts: ArtifactPreviewImageArtifactInput[]; objectKeys: string[] }> {
    const objectKeys: string[] = [];
    try {
      const previewArtifacts: ArtifactPreviewImageArtifactInput[] = [];
      for (const [index, page] of input.rendered.pages.entries()) {
        const checksum = checksumBytes(page.bytes);
        const objectKey = createArtifactPreviewObjectKey({
          job: input.job,
          leaseToken: requiredLeaseToken(input.job),
          checksum,
          pageIndex: index,
          format: input.rendered.format
        });
        objectKeys.push(objectKey);
        await this.objectStore.putObject({
          key: objectKey,
          body: page.bytes,
          contentType: page.mimeType
        });
        const pageNumber = input.sourceKind === "document" ? (page.pageNumber ?? index + 1) : undefined;
        const slideNumber =
          input.sourceKind === "presentation" ? (page.slideNumber ?? index + 1) : undefined;
        const filename = createPreviewFilename(input.source, input.sourceKind, index + 1, input.rendered.format);
        previewArtifacts.push({
          sourceFileId: input.source.sourceFileId,
          kind:
            input.sourceKind === "document"
              ? "document.preview_page_image"
              : "presentation.preview_slide_image",
          objectKey,
          filename,
          mimeType: page.mimeType,
          byteSize: page.bytes.byteLength,
          checksum,
          metadata: {
            sourceArtifactId: input.job.sourceArtifactId,
            previewRole: input.sourceKind === "document" ? "page" : "slide",
            ...(pageNumber ? { pageNumber } : {}),
            ...(slideNumber ? { slideNumber } : {}),
            rendererVersion: input.job.rendererVersion
          },
          ...(pageNumber ? { pageNumber } : {}),
          ...(slideNumber ? { slideNumber } : {}),
          ...(page.width ? { width: page.width } : {}),
          ...(page.height ? { height: page.height } : {})
        });
      }
      return { previewArtifacts, objectKeys };
    } catch {
      await this.deleteStagedObjects(objectKeys);
      throw previewFailure("storage_failed", true);
    }
  }

  private async deleteStagedObjects(objectKeys: string[]): Promise<void> {
    await Promise.allSettled(objectKeys.map((objectKey) => this.objectStore.deleteObject(objectKey)));
  }

  private markUnsupported(job: ArtifactPreviewJobRecord): Promise<ArtifactPreviewJobRecord> {
    return this.store.markClaimedArtifactPreviewJobUnsupported({
      clientInstanceId: job.clientInstanceId,
      jobId: job.id,
      leaseToken: requiredLeaseToken(job),
      errorCode: "unsupported_type",
      errorMessage: previewFailureMessage("unsupported_type"),
      unsupportedAt: this.now()
    });
  }

  private failClaimedJob(
    job: ArtifactPreviewJobRecord,
    failure: ArtifactPreviewFailure
  ): Promise<ArtifactPreviewJobRecord> {
    const failedAt = this.now();
    const canRetry = failure.retryable && job.attempts < this.maxAttempts;
    return this.store.failClaimedArtifactPreviewJob({
      clientInstanceId: job.clientInstanceId,
      jobId: job.id,
      leaseToken: requiredLeaseToken(job),
      errorCode: failure.code,
      errorMessage: previewFailureMessage(failure.code),
      failedAt,
      ...(canRetry ? { retryAt: addMilliseconds(failedAt, this.retryDelayMs) } : {})
    });
  }
}

export interface LibreOfficeArtifactPreviewRendererOptions {
  sofficeCommand?: string;
  pdfInfoCommand?: string;
  pdfToPpmCommand?: string;
  tempRootDirectory?: string;
}

export class LibreOfficeArtifactPreviewRenderer implements ArtifactPreviewRenderer {
  private readonly sofficeCommand: string;
  private readonly pdfInfoCommand: string;
  private readonly pdfToPpmCommand: string;
  private readonly tempRootDirectory: string;

  constructor(options: LibreOfficeArtifactPreviewRendererOptions = {}) {
    this.sofficeCommand = options.sofficeCommand ?? "soffice";
    this.pdfInfoCommand = options.pdfInfoCommand ?? "pdfinfo";
    this.pdfToPpmCommand = options.pdfToPpmCommand ?? "pdftoppm";
    this.tempRootDirectory = options.tempRootDirectory ?? tmpdir();
  }

  async render(input: ArtifactPreviewRenderInput): Promise<ArtifactPreviewRenderResult> {
    if (input.outputFormat !== "png") {
      throw previewFailure("unsupported_type", false);
    }
    const tempDirectory = await mkdtemp(join(this.tempRootDirectory, "catalyst-artifact-preview-"));
    try {
      const sourcePath = join(tempDirectory, `source${sourceExtension(input)}`);
      const outputDirectory = join(tempDirectory, "out");
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(sourcePath, input.bytes);
      const pdfPath = await this.convertToPdf({
        sourcePath,
        outputDirectory,
        timeoutMs: input.conversionTimeoutMs,
        signal: input.signal
      });
      const pageCount = await this.readPageCount({
        pdfPath,
        timeoutMs: input.rasterizationTimeoutMs,
        signal: input.signal
      });
      if (pageCount <= 0 || pageCount > input.maxPages) {
        throw previewFailure("page_limit_exceeded", false);
      }
      const prefix = join(outputDirectory, "page");
      await runProcess({
        command: this.pdfToPpmCommand,
        args: [
          "-png",
          "-r",
          String(input.previewDpi),
          "-f",
          "1",
          "-l",
          String(pageCount),
          pdfPath,
          prefix
        ],
        timeoutMs: input.rasterizationTimeoutMs,
        timeoutCode: "rasterization_failed",
        failureCode: "rasterization_failed",
        signal: input.signal
      });
      const pages: ArtifactPreviewRenderedPage[] = [];
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const bytes = await readFile(`${prefix}-${pageNumber}.png`);
        pages.push({
          bytes,
          mimeType: "image/png",
          ...(input.sourceKind === "document" ? { pageNumber } : { slideNumber: pageNumber }),
          ...readPngDimensions(bytes)
        });
      }
      return { format: "png", pages };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async convertToPdf(input: {
    sourcePath: string;
    outputDirectory: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<string> {
    await runProcess({
      command: this.sofficeCommand,
      args: [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--nodefault",
        "--nolockcheck",
        "--convert-to",
        "pdf",
        "--outdir",
        input.outputDirectory,
        input.sourcePath
      ],
      timeoutMs: input.timeoutMs,
      timeoutCode: "conversion_timeout",
      failureCode: "conversion_failed",
      signal: input.signal
    });
    const expected = join(
      input.outputDirectory,
      `${basename(input.sourcePath, extname(input.sourcePath))}.pdf`
    );
    const entries: string[] = await readdir(input.outputDirectory).catch((): string[] => []);
    if (entries.includes(basename(expected))) {
      return expected;
    }
    const fallback = entries.find((entry) => entry.toLowerCase().endsWith(".pdf"));
    if (!fallback) {
      throw previewFailure("conversion_failed", true);
    }
    return join(input.outputDirectory, fallback);
  }

  private async readPageCount(input: {
    pdfPath: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<number> {
    const result = await runProcess({
      command: this.pdfInfoCommand,
      args: [input.pdfPath],
      timeoutMs: input.timeoutMs,
      timeoutCode: "rasterization_failed",
      failureCode: "rasterization_failed",
      signal: input.signal
    });
    const match = /^Pages:\s+(\d+)\s*$/imu.exec(result.stdout);
    if (!match?.[1]) {
      throw previewFailure("rasterization_failed", true);
    }
    return Number(match[1]);
  }
}

interface ArtifactPreviewFailure {
  code: ArtifactPreviewFailureCode;
  retryable: boolean;
}

function previewFailure(code: ArtifactPreviewFailureCode, retryable: boolean): ArtifactPreviewFailure {
  return { code, retryable };
}

function normalizePreviewFailure(error: unknown): ArtifactPreviewFailure {
  if (isPreviewFailure(error)) {
    return error;
  }
  return previewFailure("internal_error", true);
}

function isPreviewFailure(error: unknown): error is ArtifactPreviewFailure {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    "retryable" in error &&
    typeof (error as { retryable?: unknown }).retryable === "boolean"
  );
}

function previewFailureMessage(code: ArtifactPreviewFailureCode): string {
  switch (code) {
    case "unsupported_type":
      return "Artifact type is not supported for generated previews";
    case "source_missing":
      return "Source artifact is not available";
    case "source_too_large":
      return "Source artifact exceeds the preview size limit";
    case "page_limit_exceeded":
      return "Source artifact exceeds the preview page limit";
    case "conversion_timeout":
      return "Artifact conversion timed out";
    case "conversion_failed":
      return "Artifact conversion failed";
    case "rasterization_failed":
      return "Artifact rasterization failed";
    case "storage_failed":
      return "Preview artifact storage failed";
    case "stale_lease":
      return "Artifact preview job lease expired";
    case "internal_error":
      return "Artifact preview generation failed";
  }
}

function isLeaseConflict(error: unknown): boolean {
  return error instanceof AppError && error.code === "CONFLICT";
}

function requiredLeaseToken(job: ArtifactPreviewJobRecord): string {
  if (!job.leaseToken) {
    throw new Error("Artifact preview job must have a lease token after claim");
  }
  return job.leaseToken;
}

function createArtifactPreviewObjectKey(input: {
  job: ArtifactPreviewJobRecord;
  leaseToken: string;
  checksum: string;
  pageIndex: number;
  format: ArtifactPreviewImageFormat;
}): string {
  return [
    "artifact-previews",
    encodeURIComponent(input.job.clientInstanceId),
    encodeURIComponent(input.job.conversationId),
    encodeURIComponent(input.job.sourceArtifactId),
    encodeURIComponent(input.job.id),
    encodeURIComponent(input.leaseToken),
    encodeURIComponent(input.checksum),
    `page-${input.pageIndex + 1}.${input.format}`
  ].join("/");
}

function createPreviewFilename(
  source: ManagedArtifactRecord,
  sourceKind: ArtifactPreviewSourceKind,
  position: number,
  format: ArtifactPreviewImageFormat
): string {
  const base = basename(source.filename ?? source.id, extname(source.filename ?? source.id));
  const role = sourceKind === "document" ? "page" : "slide";
  return `${base}-${role}-${position}.${format}`;
}

function sourceExtension(input: ArtifactPreviewRenderInput): string {
  const extension = extname(input.filename ?? "").toLowerCase();
  if ([".doc", ".docx", ".ppt", ".pptx"].includes(extension)) {
    return extension;
  }
  if (input.mimeType.includes("presentation") || input.mimeType.includes("powerpoint")) {
    return ".pptx";
  }
  return ".docx";
}

function checksumBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function addMilliseconds(isoDate: string, milliseconds: number): string {
  return new Date(new Date(isoDate).getTime() + milliseconds).toISOString();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runProcess(input: {
  command: string;
  args: string[];
  timeoutMs: number;
  timeoutCode: ArtifactPreviewFailureCode;
  failureCode: ArtifactPreviewFailureCode;
  signal?: AbortSignal;
}): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let stdout = "";
    const child = spawn(input.command, input.args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: input.signal
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-65536);
    });
    child.stderr.on("data", () => undefined);
    child.on("error", () => {
      clearTimeout(timer);
      reject(previewFailure(input.failureCode, true));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(previewFailure(input.timeoutCode, true));
        return;
      }
      if (code !== 0) {
        reject(previewFailure(input.failureCode, true));
        return;
      }
      resolve({ stdout });
    });
  });
}

function readPngDimensions(bytes: Uint8Array): { width?: number; height?: number } {
  if (
    bytes.byteLength < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return {};
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20)
  };
}
