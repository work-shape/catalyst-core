import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import * as XLSX from "xlsx";
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
import { readArtifactPreviewSettingsHash } from "./artifact-preview-settings";
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
const MAX_SPREADSHEET_PREVIEW_CELLS = 5000;

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
  pages?: number[];
  slides?: number[];
  sheets?: string[];
  ranges?: string[];
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
  sheet?: string;
  range?: string;
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

    const renderSettings = readArtifactPreviewSettingsHash(job.settingsHash);
    const rendered = await this.renderer.render({
      sourceKind,
      filename: source.filename,
      mimeType: source.mimeType,
      bytes: sourceBytes,
      ...(renderSettings.pages ? { pages: renderSettings.pages } : {}),
      ...(renderSettings.slides ? { slides: renderSettings.slides } : {}),
      ...(renderSettings.sheets ? { sheets: renderSettings.sheets } : {}),
      ...(renderSettings.ranges ? { ranges: renderSettings.ranges } : {}),
      maxPages: Math.min(renderSettings.maxImages ?? this.maxPages, this.maxPages),
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
        const pageNumber =
          input.sourceKind === "document" || input.sourceKind === "pdf"
            ? (page.pageNumber ?? index + 1)
            : undefined;
        const slideNumber =
          input.sourceKind === "presentation" ? (page.slideNumber ?? index + 1) : undefined;
        const filename = createPreviewFilename(input.source, input.sourceKind, index + 1, input.rendered.format);
        const previewRole = previewRoleForPage(input.sourceKind, page);
        previewArtifacts.push({
          sourceFileId: input.source.sourceFileId,
          kind: previewArtifactKind(input.sourceKind, page),
          objectKey,
          filename,
          mimeType: page.mimeType,
          byteSize: page.bytes.byteLength,
          checksum,
          metadata: {
            sourceArtifactId: input.job.sourceArtifactId,
            previewRole,
            ...(pageNumber ? { pageNumber } : {}),
            ...(slideNumber ? { slideNumber } : {}),
            ...(page.sheet ? { sheet: page.sheet } : {}),
            ...(page.range ? { range: page.range } : {}),
            rendererVersion: input.job.rendererVersion
          },
          ...(pageNumber ? { pageNumber } : {}),
          ...(slideNumber ? { slideNumber } : {}),
          ...(page.sheet ? { sheet: page.sheet } : {}),
          ...(page.range ? { range: page.range } : {}),
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
      if (input.sourceKind === "spreadsheet") {
        return await this.renderSpreadsheet(input, tempDirectory);
      }
      const sourcePath = join(tempDirectory, `source${sourceExtension(input)}`);
      const outputDirectory = join(tempDirectory, "out");
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(sourcePath, input.bytes);
      const pdfPath =
        input.sourceKind === "pdf"
          ? sourcePath
          : await this.convertToPdf({
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
      if (pageCount <= 0) {
        throw previewFailure("page_limit_exceeded", false);
      }
      const pageNumbers = rasterPageNumbers(input, pageCount);
      const pages: ArtifactPreviewRenderedPage[] = [];
      for (const [index, pageNumber] of pageNumbers.entries()) {
        const bytes = await this.rasterizePdfPage({
          input,
          outputDirectory,
          pageIndex: index,
          pageNumber,
          pdfPath
        });
        pages.push({
          bytes,
          mimeType: "image/png",
          ...(input.sourceKind === "document" || input.sourceKind === "pdf"
            ? { pageNumber }
            : {}),
          ...(input.sourceKind === "presentation" ? { slideNumber: pageNumber } : {}),
          ...readPngDimensions(bytes)
        });
      }
      return { format: "png", pages };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async renderSpreadsheet(
    input: ArtifactPreviewRenderInput,
    tempDirectory: string
  ): Promise<ArtifactPreviewRenderResult> {
    const workbook = readSpreadsheetWorkbook(input.bytes);
    const selections = spreadsheetRenderSelections(workbook, input);
    if (selections.length === 0 || selections.length > input.maxPages) {
      throw previewFailure("page_limit_exceeded", false);
    }

    const pages: ArtifactPreviewRenderedPage[] = [];
    for (const [index, selection] of selections.entries()) {
      const sourcePath = join(tempDirectory, `spreadsheet-preview-${index + 1}.xlsx`);
      const outputDirectory = join(tempDirectory, `spreadsheet-out-${index + 1}`);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(sourcePath, createSpreadsheetPreviewWorkbookBytes(workbook, selection));
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
      if (pageCount <= 0) {
        throw previewFailure("page_limit_exceeded", false);
      }
      const bytes = await this.rasterizePdfPage({
        input,
        outputDirectory,
        pageIndex: index,
        pageNumber: 1,
        pdfPath
      });
      pages.push({
        bytes,
        mimeType: "image/png",
        sheet: selection.sheetName,
        ...(selection.metadataRange ? { range: selection.metadataRange } : {}),
        ...readPngDimensions(bytes)
      });
    }

    return { format: "png", pages };
  }

  private async rasterizePdfPage(input: {
    input: ArtifactPreviewRenderInput;
    outputDirectory: string;
    pageIndex: number;
    pageNumber: number;
    pdfPath: string;
  }): Promise<Uint8Array> {
    const prefix = join(input.outputDirectory, `page-${input.pageIndex + 1}`);
    await runProcess({
      command: this.pdfToPpmCommand,
      args: [
        "-png",
        "-singlefile",
        "-r",
        String(input.input.previewDpi),
        "-f",
        String(input.pageNumber),
        "-l",
        String(input.pageNumber),
        input.pdfPath,
        prefix
      ],
      timeoutMs: input.input.rasterizationTimeoutMs,
      timeoutCode: "rasterization_failed",
      failureCode: "rasterization_failed",
      signal: input.input.signal
    });
    return readFile(`${prefix}.png`);
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
  const role = previewRoleForSourceKind(sourceKind);
  return `${base}-${role}-${position}.${format}`;
}

function sourceExtension(input: ArtifactPreviewRenderInput): string {
  const extension = extname(input.filename ?? "").toLowerCase();
  if ([".doc", ".docx", ".ppt", ".pptx", ".pdf", ".xls", ".xlsx", ".ods"].includes(extension)) {
    return extension;
  }
  if (input.sourceKind === "pdf" || input.mimeType.includes("pdf")) {
    return ".pdf";
  }
  if (input.mimeType.includes("presentation") || input.mimeType.includes("powerpoint")) {
    return ".pptx";
  }
  if (
    input.sourceKind === "spreadsheet" ||
    input.mimeType.includes("spreadsheet") ||
    input.mimeType.includes("excel")
  ) {
    return ".xlsx";
  }
  return ".docx";
}

function rasterPageNumbers(input: ArtifactPreviewRenderInput, pageCount: number): number[] {
  const requested = numericRasterSelection(input);
  if (requested.length > 0) {
    const selected = requested.filter((pageNumber) => pageNumber <= pageCount);
    if (selected.length === 0 || selected.length > input.maxPages) {
      throw previewFailure("page_limit_exceeded", false);
    }
    return selected;
  }
  if (pageCount > input.maxPages) {
    throw previewFailure("page_limit_exceeded", false);
  }
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

function numericRasterSelection(input: ArtifactPreviewRenderInput): number[] {
  if (input.sourceKind === "presentation") {
    return input.slides ?? [];
  }
  if (input.sourceKind === "document" || input.sourceKind === "pdf") {
    return input.pages ?? [];
  }
  return [];
}

function previewArtifactKind(
  sourceKind: ArtifactPreviewSourceKind,
  page: ArtifactPreviewRenderedPage
): string {
  if (sourceKind === "presentation") {
    return "presentation.preview_slide_image";
  }
  if (sourceKind === "spreadsheet") {
    return page.range ? "spreadsheet.preview_range_image" : "spreadsheet.preview_sheet_image";
  }
  return "document.preview_page_image";
}

function previewRoleForPage(
  sourceKind: ArtifactPreviewSourceKind,
  page: ArtifactPreviewRenderedPage
): string {
  if (sourceKind === "spreadsheet") {
    return page.range ? "range" : "sheet";
  }
  return previewRoleForSourceKind(sourceKind);
}

function previewRoleForSourceKind(sourceKind: ArtifactPreviewSourceKind): string {
  if (sourceKind === "presentation") {
    return "slide";
  }
  if (sourceKind === "spreadsheet") {
    return "sheet";
  }
  return "page";
}

interface SpreadsheetRenderSelection {
  sheetName: string;
  metadataRange?: string;
  range: XLSX.Range;
}

function readSpreadsheetWorkbook(bytes: Uint8Array): XLSX.WorkBook {
  try {
    return XLSX.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      cellStyles: true,
      type: "buffer"
    });
  } catch {
    throw previewFailure("conversion_failed", false);
  }
}

function spreadsheetRenderSelections(
  workbook: XLSX.WorkBook,
  input: ArtifactPreviewRenderInput
): SpreadsheetRenderSelection[] {
  if (input.ranges?.length) {
    const selections = input.ranges.flatMap((rangeText, index) => {
      if (input.sheets && input.sheets.length > 1 && input.ranges?.length === 1) {
        return input.sheets.map((sheetName) =>
          spreadsheetSelectionFromRange(workbook, rangeText, sheetName)
        );
      }
      return [
        spreadsheetSelectionFromRange(
          workbook,
          rangeText,
          input.sheets?.[index] ?? input.sheets?.[0]
        )
      ];
    });
    return selections.slice(0, input.maxPages);
  }

  if (input.sheets?.length) {
    return input.sheets
      .slice(0, input.maxPages)
      .map((sheetName) => spreadsheetSelectionFromSheet(workbook, sheetName));
  }

  return workbook.SheetNames.slice(0, input.maxPages).map((sheetName) =>
    spreadsheetSelectionFromSheet(workbook, sheetName)
  );
}

function spreadsheetSelectionFromRange(
  workbook: XLSX.WorkBook,
  rangeText: string,
  fallbackSheetName: string | undefined
): SpreadsheetRenderSelection {
  const parsed = splitQualifiedSpreadsheetRange(rangeText);
  const sheetName = resolveSpreadsheetSheetName(workbook, parsed.sheetName ?? fallbackSheetName);
  const range = decodeSpreadsheetRange(parsed.rangeText);
  assertSpreadsheetRangeBounds(range);
  return {
    sheetName,
    metadataRange: formatSpreadsheetRange(sheetName, range),
    range
  };
}

function spreadsheetSelectionFromSheet(
  workbook: XLSX.WorkBook,
  requestedSheetName: string
): SpreadsheetRenderSelection {
  const sheetName = resolveSpreadsheetSheetName(workbook, requestedSheetName);
  const worksheet = workbook.Sheets[sheetName];
  const ref = typeof worksheet?.["!ref"] === "string" ? worksheet["!ref"] : "A1:A1";
  const range = decodeSpreadsheetRange(ref);
  assertSpreadsheetRangeBounds(range);
  return { sheetName, range };
}

function resolveSpreadsheetSheetName(
  workbook: XLSX.WorkBook,
  requestedSheetName: string | undefined
): string {
  const name = requestedSheetName?.trim() || workbook.SheetNames[0];
  const match = workbook.SheetNames.find(
    (sheetName) => sheetName.toLowerCase() === name?.toLowerCase()
  );
  if (!match) {
    throw previewFailure("conversion_failed", false);
  }
  return match;
}

function splitQualifiedSpreadsheetRange(input: string): { sheetName?: string; rangeText: string } {
  const trimmed = input.trim();
  let inQuotedSheet = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "'") {
      if (inQuotedSheet && trimmed[index + 1] === "'") {
        index += 1;
        continue;
      }
      inQuotedSheet = !inQuotedSheet;
      continue;
    }
    if (char === "!" && !inQuotedSheet) {
      return {
        sheetName: unquoteSpreadsheetSheetName(trimmed.slice(0, index)),
        rangeText: trimmed.slice(index + 1)
      };
    }
  }
  return { rangeText: trimmed };
}

function unquoteSpreadsheetSheetName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function decodeSpreadsheetRange(rangeText: string): XLSX.Range {
  try {
    return XLSX.utils.decode_range(rangeText.trim());
  } catch {
    throw previewFailure("conversion_failed", false);
  }
}

function assertSpreadsheetRangeBounds(range: XLSX.Range): void {
  const rowCount = range.e.r - range.s.r + 1;
  const columnCount = range.e.c - range.s.c + 1;
  if (
    rowCount <= 0 ||
    columnCount <= 0 ||
    rowCount * columnCount > MAX_SPREADSHEET_PREVIEW_CELLS
  ) {
    throw previewFailure("page_limit_exceeded", false);
  }
}

function formatSpreadsheetRange(sheetName: string, range: XLSX.Range): string {
  return `${quoteSpreadsheetSheetName(sheetName)}!${XLSX.utils.encode_range(range)}`;
}

function quoteSpreadsheetSheetName(sheetName: string): string {
  return /^[A-Za-z0-9_]+$/u.test(sheetName) ? sheetName : `'${sheetName.replaceAll("'", "''")}'`;
}

function createSpreadsheetPreviewWorkbookBytes(
  workbook: XLSX.WorkBook,
  selection: SpreadsheetRenderSelection
): Uint8Array {
  const sourceSheet = workbook.Sheets[selection.sheetName];
  if (!sourceSheet) {
    throw previewFailure("conversion_failed", false);
  }
  const outputSheet = copySpreadsheetRangeForPreview(sourceSheet, selection.range);
  const outputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outputWorkbook, outputSheet, previewSheetName(selection.sheetName));
  const bytes = XLSX.write(outputWorkbook, {
    bookType: "xlsx",
    cellStyles: true,
    type: "buffer"
  }) as Uint8Array | string;
  return typeof bytes === "string" ? Buffer.from(bytes, "binary") : bytes;
}

function copySpreadsheetRangeForPreview(
  sourceSheet: XLSX.WorkSheet,
  range: XLSX.Range
): XLSX.WorkSheet {
  const outputSheet: XLSX.WorkSheet = {
    "!ref": XLSX.utils.encode_range({
      s: { c: 0, r: 0 },
      e: {
        c: range.e.c - range.s.c,
        r: range.e.r - range.s.r
      }
    })
  };

  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const sourceAddress = XLSX.utils.encode_cell({ c: column, r: row });
      const sourceCell = sourceSheet[sourceAddress] as XLSX.CellObject | undefined;
      if (!sourceCell) {
        continue;
      }
      const targetAddress = XLSX.utils.encode_cell({
        c: column - range.s.c,
        r: row - range.s.r
      });
      outputSheet[targetAddress] = spreadsheetPreviewCell(sourceCell);
    }
  }

  const sourceColumns = sourceSheet["!cols"];
  if (sourceColumns) {
    outputSheet["!cols"] = sourceColumns
      .slice(range.s.c, range.e.c + 1)
      .map((column) => ({ ...column }));
  }
  const sourceRows = sourceSheet["!rows"];
  if (sourceRows) {
    outputSheet["!rows"] = sourceRows
      .slice(range.s.r, range.e.r + 1)
      .map((row) => ({ ...row }));
  }
  const merges = sourceSheet["!merges"] ?? [];
  const copiedMerges = merges.flatMap((merge) => {
    if (
      merge.s.r < range.s.r ||
      merge.e.r > range.e.r ||
      merge.s.c < range.s.c ||
      merge.e.c > range.e.c
    ) {
      return [];
    }
    return [
      {
        s: { c: merge.s.c - range.s.c, r: merge.s.r - range.s.r },
        e: { c: merge.e.c - range.s.c, r: merge.e.r - range.s.r }
      }
    ];
  });
  if (copiedMerges.length > 0) {
    outputSheet["!merges"] = copiedMerges;
  }
  return outputSheet;
}

function spreadsheetPreviewCell(sourceCell: XLSX.CellObject): XLSX.CellObject {
  const cell: XLSX.CellObject = { ...sourceCell };
  if (cell.f) {
    delete cell.f;
    delete cell.F;
    if (cell.v === undefined && sourceCell.w !== undefined) {
      cell.t = "s";
      cell.v = sourceCell.w;
    }
  }
  return cell;
}

function previewSheetName(sheetName: string): string {
  const cleaned = sheetName.replaceAll(/[:\\/?*\[\]]/gu, " ").trim();
  return (cleaned || "Preview").slice(0, 31);
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
