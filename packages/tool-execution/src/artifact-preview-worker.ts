import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import {
  AppError,
  ARTIFACT_PREVIEW_MAX_PAGES,
  JobLeaseLostError,
  NonRetryableJobError,
  claimSubjectRow,
  defineJobHandler,
  detectArtifactPreviewSourceKind,
  renderArtifactPreviewJob,
  subjectRowLeaseOwnerId,
  type ArtifactPreviewImageArtifactInput,
  type ArtifactPreviewImageFormat,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewSourceKind,
  type ClientInstanceId,
  type Job,
  type JobControl,
  type ManagedArtifactRecord,
  type PlatformStores,
  type RegisteredJobHandler,
  readObjectBytes,
  type ObjectStorage
} from "@vivd-catalyst/core";
import { readArtifactPreviewSettingsHash } from "./artifact-preview-settings";
import {
  LibreOfficeArtifactPreviewRenderer,
  type ArtifactPreviewRenderedModelImage,
  type ArtifactPreviewRenderedPage,
  type ArtifactPreviewRenderResult,
  type ArtifactPreviewRenderer
} from "./artifact-preview-renderer";
import {
  normalizePreviewFailure,
  previewFailure,
  previewFailureMessage,
  type ArtifactPreviewFailure
} from "./artifact-preview-failures";

export {
  LibreOfficeArtifactPreviewRenderer,
  SPREADSHEET_PREVIEW_MAX_CELLS,
  type ArtifactPreviewRenderedModelImage,
  type ArtifactPreviewRenderedPage,
  type ArtifactPreviewRenderInput,
  type ArtifactPreviewRenderResult,
  type ArtifactPreviewRenderer
} from "./artifact-preview-renderer";

const DEFAULT_MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const HARD_MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_CONVERTED_PDF_BYTES = 256 * 1024 * 1024;
const HARD_MAX_CONVERTED_PDF_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const HARD_MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 80;
const DEFAULT_MAX_RASTER_DIMENSION = 4096;
const HARD_MAX_RASTER_DIMENSION = 8192;
const DEFAULT_CONVERSION_TIMEOUT_MS = 180000;
const DEFAULT_RASTERIZATION_TIMEOUT_MS = 180000;
const DEFAULT_PREVIEW_DPI = 144;
const DEFAULT_OUTPUT_FORMAT: ArtifactPreviewImageFormat = "png";

// The lease an exhausted job writes onto its row for the moment in which it marks it failed.
const EXHAUSTED_ROW_LEASE_MS = 60 * 1000;

export interface ArtifactPreviewJobHandlerOptions {
  /** The stores of the process. Reads go through them, writes through the job's transaction. */
  stores: Pick<PlatformStores, "files">;
  /** Where preview images are written and sources are read: the `workspaces` store. */
  objectStore: ObjectStorage;
  sourceReader?: ArtifactPreviewSourceReader;
  renderer?: ArtifactPreviewRenderer;
  /** How many previews this process renders at once. */
  slots?: number;
  maxSourceBytes?: number;
  maxConvertedPdfBytes?: number;
  maxOutputBytes?: number;
  maxPages?: number;
  maxRasterDimension?: number;
  conversionTimeoutMs?: number;
  rasterizationTimeoutMs?: number;
  previewDpi?: number;
  outputFormat?: ArtifactPreviewImageFormat;
  now?: () => string;
  /** Replaces the five seconds between two looks at a row another worker holds. For tests. */
  yieldCheckIntervalMs?: number;
}

export interface ArtifactPreviewSourceReader {
  readArtifact(input: {
    clientInstanceId: ClientInstanceId;
    artifactId: ManagedArtifactRecord["id"];
  }): Promise<{ bytes: Uint8Array }>;
}

type PreviewJob = Job<{ previewJobId: string }>;

/** The row is no longer this attempt's: another worker finished it or its conversation is gone. */
class PreviewRowLostError extends Error {}

/**
 * The handler of `artifact_preview.render`. The executor job is the only claim on a preview
 * row; the handler takes the row by id, renders, and writes the row's status and result
 * inside the job's fenced transaction.
 */
export function createArtifactPreviewJobHandler(
  options: ArtifactPreviewJobHandlerOptions
): RegisteredJobHandler {
  const render = new ArtifactPreviewRender(options);
  return defineJobHandler({
    kind: renderArtifactPreviewJob,
    slots: options.slots ?? 1,
    run: (job, control) => render.run(job, control),
    // Transition release: the lease is copied onto the row for workers of the previous release.
    async onHeartbeat(job, lease, stores) {
      await stores.files.renewClaimedArtifactPreviewJobLease({
        clientInstanceId: job.clientInstanceId,
        jobId: job.payload.previewJobId,
        leaseToken: lease.leaseToken,
        leaseMs: renderArtifactPreviewJob.leaseMs
      });
    },
    onExhausted: (job, stores) => render.failAfterLastAttempt(job, stores)
  });
}

class ArtifactPreviewRender {
  private readonly store: Pick<PlatformStores, "files">["files"];
  private readonly objectStore: ObjectStorage;
  private readonly sourceReader?: ArtifactPreviewSourceReader;
  private readonly renderer: ArtifactPreviewRenderer;
  private readonly maxSourceBytes: number;
  private readonly maxConvertedPdfBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxPages: number;
  private readonly maxRasterDimension: number;
  private readonly conversionTimeoutMs: number;
  private readonly rasterizationTimeoutMs: number;
  private readonly previewDpi: number;
  private readonly outputFormat: ArtifactPreviewImageFormat;
  private readonly now: () => string;
  private readonly yieldCheckIntervalMs?: number;

  constructor(options: ArtifactPreviewJobHandlerOptions) {
    this.store = options.stores.files;
    this.objectStore = options.objectStore;
    this.sourceReader = options.sourceReader;
    this.renderer = options.renderer ?? new LibreOfficeArtifactPreviewRenderer();
    this.maxSourceBytes = Math.min(
      options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
      HARD_MAX_SOURCE_BYTES
    );
    this.maxConvertedPdfBytes = Math.min(
      options.maxConvertedPdfBytes ?? DEFAULT_MAX_CONVERTED_PDF_BYTES,
      HARD_MAX_CONVERTED_PDF_BYTES
    );
    this.maxOutputBytes = Math.min(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      HARD_MAX_OUTPUT_BYTES
    );
    this.maxPages = Math.min(options.maxPages ?? DEFAULT_MAX_PAGES, ARTIFACT_PREVIEW_MAX_PAGES);
    this.maxRasterDimension = Math.min(
      options.maxRasterDimension ?? DEFAULT_MAX_RASTER_DIMENSION,
      HARD_MAX_RASTER_DIMENSION
    );
    this.conversionTimeoutMs = options.conversionTimeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS;
    this.rasterizationTimeoutMs =
      options.rasterizationTimeoutMs ?? DEFAULT_RASTERIZATION_TIMEOUT_MS;
    this.previewDpi = options.previewDpi ?? DEFAULT_PREVIEW_DPI;
    this.outputFormat = options.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
    this.now = options.now ?? (() => new Date().toISOString());
    this.yieldCheckIntervalMs = options.yieldCheckIntervalMs;
  }

  async run(job: PreviewJob, control: JobControl): Promise<void> {
    // Yield: a row a worker of the previous release holds is left to it until its lease ends.
    const row = await claimSubjectRow(
      control,
      (stores) =>
        stores.files.claimArtifactPreviewJob({
          clientInstanceId: job.clientInstanceId,
          jobId: job.payload.previewJobId,
          leaseOwnerId: subjectRowLeaseOwnerId(job.id),
          leaseToken: control.leaseToken,
          leaseMs: renderArtifactPreviewJob.leaseMs
        }),
      this.yieldCheckIntervalMs
    );
    if (!row) return;
    try {
      try {
        await this.renderClaimedRow(row, control);
      } catch (error: unknown) {
        // A stopped or taken-over attempt writes nothing: the executor gives the job back or
        // has given it to another attempt, which takes the row over.
        if (control.signal.aborted || error instanceof JobLeaseLostError) throw error;
        const failure = normalizePreviewFailure(error);
        if (failure.code === "unsupported_type") await this.markUnsupported(row, control);
        else await this.fail(job, row, failure, control);
      }
    } catch (error: unknown) {
      if (error instanceof PreviewRowLostError) return;
      throw error;
    }
  }

  /**
   * The lease expired on the last attempt. Runs in the transaction that marks the job dead:
   * the row fails with it unless it is finished or a worker of the previous release holds it.
   */
  async failAfterLastAttempt(job: PreviewJob, stores: PlatformStores): Promise<void> {
    const leaseToken = randomUUID();
    const claim = await stores.files.claimArtifactPreviewJob({
      clientInstanceId: job.clientInstanceId,
      jobId: job.payload.previewJobId,
      leaseOwnerId: subjectRowLeaseOwnerId(job.id),
      leaseToken,
      leaseMs: EXHAUSTED_ROW_LEASE_MS
    });
    if (claim.status !== "claimed") return;
    await stores.files.failClaimedArtifactPreviewJob({
      clientInstanceId: job.clientInstanceId,
      jobId: claim.row.id,
      leaseToken,
      errorCode: "stale_lease",
      errorMessage: previewFailureMessage("stale_lease"),
      failedAt: this.now()
    });
  }

  /**
   * A failure with an attempt left leaves the row as it is, held by this job, and the executor
   * runs the job again after its backoff. A failure that another attempt cannot help, and the
   * failure of the last attempt, are written to the row.
   */
  private async fail(
    job: PreviewJob,
    row: ArtifactPreviewJobRecord,
    failure: ArtifactPreviewFailure,
    control: JobControl
  ): Promise<never> {
    const message = failure.message ?? previewFailureMessage(failure.code);
    if (failure.retryable && control.attempt < job.maxAttempts)
      throw new AppError("INTERNAL", `Artifact preview failed: ${failure.code}`);
    await this.writeRow(control, (stores) =>
      stores.files.failClaimedArtifactPreviewJob({
        clientInstanceId: row.clientInstanceId,
        jobId: row.id,
        leaseToken: requiredLeaseToken(row),
        errorCode: failure.code,
        errorMessage: message,
        failedAt: this.now()
      })
    );
    if (failure.retryable)
      throw new AppError("INTERNAL", `Artifact preview failed: ${failure.code}`);
    throw new NonRetryableJobError(`Artifact preview failed: ${failure.code}`);
  }

  private async markUnsupported(row: ArtifactPreviewJobRecord, control: JobControl): Promise<void> {
    await this.writeRow(control, (stores) =>
      stores.files.markClaimedArtifactPreviewJobUnsupported({
        clientInstanceId: row.clientInstanceId,
        jobId: row.id,
        leaseToken: requiredLeaseToken(row),
        errorCode: "unsupported_type",
        errorMessage: previewFailureMessage("unsupported_type"),
        unsupportedAt: this.now()
      })
    );
  }

  /**
   * Writes the row inside the job's fenced transaction. The store refuses a row that this
   * attempt no longer holds; that is no failure of the preview.
   */
  private async writeRow<Result>(
    control: JobControl,
    write: (stores: PlatformStores) => Promise<Result>
  ): Promise<Result> {
    try {
      return await control.transaction(write);
    } catch (error: unknown) {
      if (isRowConflict(error)) throw new PreviewRowLostError();
      throw error;
    }
  }

  private async renderClaimedRow(
    job: ArtifactPreviewJobRecord,
    control: JobControl
  ): Promise<void> {
    const signal = control.signal;
    const source = await this.store.getManagedArtifact({
      clientInstanceId: job.clientInstanceId,
      artifactId: job.sourceArtifactId
    });
    if (
      !source ||
      source.conversationId !== job.conversationId ||
      source.checksum !== job.sourceChecksum
    ) {
      throw previewFailure("source_missing", false);
    }

    const sourceKind = detectArtifactPreviewSourceKind(source);
    if (!sourceKind) {
      throw previewFailure("unsupported_type", false);
    }
    if (source.byteSize > this.maxSourceBytes) {
      throw previewFailure("source_too_large", false);
    }

    const sourceBytes = await this.readSourceBytes(source);
    if (sourceBytes.byteLength > this.maxSourceBytes) {
      throw previewFailure("source_too_large", false);
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
      maxConvertedPdfBytes: this.maxConvertedPdfBytes,
      maxOutputBytes: this.maxOutputBytes,
      maxRasterDimension: this.maxRasterDimension,
      previewDpi: this.previewDpi,
      outputFormat: this.outputFormat,
      conversionTimeoutMs: this.conversionTimeoutMs,
      rasterizationTimeoutMs: this.rasterizationTimeoutMs,
      signal
    });
    if (rendered.pages.length === 0 || rendered.pages.length > this.maxPages) {
      throw previewFailure("page_limit_exceeded", false);
    }
    const outputBytes = rendered.pages.reduce((total, page) => total + page.bytes.byteLength, 0);
    const oversizedPage = rendered.pages.some(
      (page) =>
        (page.width !== undefined && page.width > this.maxRasterDimension) ||
        (page.height !== undefined && page.height > this.maxRasterDimension)
    );
    if (outputBytes > this.maxOutputBytes || oversizedPage) {
      throw previewFailure("output_too_large", false);
    }

    const staged = await this.stageRenderedPages({
      job,
      source,
      sourceKind,
      rendered
    });
    try {
      await control.transaction((stores) =>
        stores.files.completeClaimedArtifactPreviewJob({
          clientInstanceId: job.clientInstanceId,
          jobId: job.id,
          leaseToken: requiredLeaseToken(job),
          format: rendered.format,
          previewArtifacts: staged.previewArtifacts,
          sourcePageCount: rendered.pageCount,
          completedAt: this.now()
        })
      );
    } catch (error: unknown) {
      await this.deleteStagedObjects(staged.objectKeys);
      // The store refuses a row this attempt no longer holds and a source that went away.
      if (isRowConflict(error)) throw previewFailure("source_missing", false);
      throw error;
    }
  }

  private async readSourceBytes(source: ManagedArtifactRecord): Promise<Uint8Array> {
    try {
      return await readObjectBytes(this.objectStore, source.objectKey);
    } catch (localError) {
      if (!this.sourceReader) {
        throw previewFailure("source_missing", false);
      }
      try {
        return (
          await this.sourceReader.readArtifact({
            clientInstanceId: source.clientInstanceId,
            artifactId: source.id
          })
        ).bytes;
      } catch {
        void localError;
        throw previewFailure("source_missing", false);
      }
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
        await this.objectStore.put(objectKey, page.bytes, { contentType: page.mimeType });
        const pageNumber =
          input.sourceKind === "document" || input.sourceKind === "pdf"
            ? (page.pageNumber ?? index + 1)
            : undefined;
        const slideNumber =
          input.sourceKind === "presentation" ? (page.slideNumber ?? index + 1) : undefined;
        const filename = createPreviewFilename(
          input.source,
          input.sourceKind,
          index + 1,
          input.rendered.format
        );
        const previewRole = previewRoleForPage(input.sourceKind, page);
        const modelImage = page.modelImage
          ? await this.stageModelImage(page.modelImage, objectKey, filename, objectKeys)
          : undefined;
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
          ...(page.height ? { height: page.height } : {}),
          ...(modelImage ? { modelImage } : {})
        });
      }
      return { previewArtifacts, objectKeys };
    } catch {
      await this.deleteStagedObjects(objectKeys);
      throw previewFailure("storage_failed", true);
    }
  }

  /** Stores the model's rendition of a page beside the page image and records its key. */
  private async stageModelImage(
    image: ArtifactPreviewRenderedModelImage,
    pageObjectKey: string,
    pageFilename: string,
    objectKeys: string[]
  ): Promise<NonNullable<ArtifactPreviewImageArtifactInput["modelImage"]>> {
    const extension = imageExtension(image.mimeType);
    const objectKey = `${withoutExtension(pageObjectKey)}.model.${extension}`;
    objectKeys.push(objectKey);
    await this.objectStore.put(objectKey, image.bytes, { contentType: image.mimeType });
    return {
      objectKey,
      filename: `${withoutExtension(pageFilename)}.model.${extension}`,
      mimeType: image.mimeType,
      byteSize: image.bytes.byteLength,
      checksum: checksumBytes(image.bytes),
      ...(image.width ? { width: image.width } : {}),
      ...(image.height ? { height: image.height } : {})
    };
  }

  private async deleteStagedObjects(objectKeys: string[]): Promise<void> {
    await Promise.allSettled(objectKeys.map((objectKey) => this.objectStore.delete(objectKey)));
  }
}

/** A conflict the files store raised about the row, not the executor about the job's lease. */
function isRowConflict(error: unknown): boolean {
  return (
    error instanceof AppError && error.code === "CONFLICT" && !(error instanceof JobLeaseLostError)
  );
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

function withoutExtension(name: string): string {
  return name.slice(0, name.length - extname(name).length);
}

function imageExtension(mimeType: ArtifactPreviewRenderedModelImage["mimeType"]): string {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
}

function checksumBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
