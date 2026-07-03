import type { z } from "zod";
import {
  asManagedArtifactId,
  detectArtifactPreviewSourceKind,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewManifest,
  type ClientInstanceId,
  type JsonObject,
  type ManagedArtifactId,
  type ManagedArtifactRecord,
  type ManagedArtifactRef,
  type PlatformStore,
  type SupportedImageMimeType,
  type ToolExecutionContext,
  type ToolHandlerResult
} from "@vivd-catalyst/core";
import { toolSuccess } from "@vivd-catalyst/tool-sdk";
import type {
  workspacePreviewImagesInputSchema,
  workspacePreviewImagesOutputSchema
} from "./workspace-tool-schemas";
import { createArtifactPreviewSettingsHash } from "./artifact-preview-settings";
import { failed } from "./workspace-tool-results";

export type WorkspacePreviewImagesInput = z.infer<typeof workspacePreviewImagesInputSchema>;
export type WorkspacePreviewImagesOutput = z.infer<typeof workspacePreviewImagesOutputSchema>;

export type WorkspacePreviewImagesStore = Pick<
  PlatformStore,
  | "enqueueArtifactPreviewJob"
  | "getArtifactPreviewJob"
  | "getArtifactPreviewManifest"
  | "getManagedArtifact"
>;

export interface ResolveWorkspacePreviewImagesOptions {
  store: WorkspacePreviewImagesStore;
  maxImages: number;
}

interface PreviewImageCandidate {
  artifactId: ManagedArtifactId;
  mimeType: SupportedImageMimeType;
  pageNumber?: number;
  slideNumber?: number;
  sheet?: string;
  range?: string;
  width?: number;
  height?: number;
}

type PreviewWarning = WorkspacePreviewImagesOutput["warnings"][number];

interface NormalizedSelection {
  pageNumbers?: Set<number>;
  slideNumbers?: Set<number>;
  sheets?: Set<string>;
  ranges?: Set<string>;
  hasSelection: boolean;
}

export async function resolveWorkspacePreviewImages(
  input: WorkspacePreviewImagesInput,
  context: ToolExecutionContext,
  options: ResolveWorkspacePreviewImagesOptions
): Promise<ToolHandlerResult<WorkspacePreviewImagesOutput>> {
  const conversationId = context.toolRequest?.conversationId;
  if (!conversationId) {
    return failed("handler_failed", "workspace.preview_images requires an active tool request");
  }
  if (!input.artifactId) {
    return failed("handler_failed", "workspace.preview_images requires artifactId for managed artifact previews");
  }

  const source = await options.store.getManagedArtifact({
    clientInstanceId: context.clientInstanceId,
    artifactId: asManagedArtifactId(input.artifactId)
  });
  if (!source || source.conversationId !== conversationId || source.status !== "available") {
    return failed("handler_failed", "Managed artifact is not available in this conversation", {
      artifactId: input.artifactId
    });
  }

  const maxImages = Math.min(input.maxImages ?? options.maxImages, options.maxImages);
  const normalizedInput = normalizePreviewImagesInput(input);
  if (!normalizedInput.ok) {
    return failed("handler_failed", normalizedInput.error.message, normalizedInput.error.details);
  }
  const selectorCount = countRequestedPreviewImages(normalizedInput.input);
  if (selectorCount > maxImages) {
    return failed("handler_failed", "workspace.preview_images selector count exceeds maxImages", {
      selectorCount,
      maxImages
    });
  }
  const selection = normalizeSelection(normalizedInput.input);
  const settingsHash = createArtifactPreviewSettingsHash({
    pages: normalizedInput.input.pages,
    slides: normalizedInput.input.slides,
    sheets: normalizedInput.input.sheets,
    ranges: normalizedInput.input.ranges,
    maxImages
  });
  const warnings: PreviewWarning[] = [];

  if (isSupportedImageMimeType(source.mimeType)) {
    if (selection.hasSelection) {
      return success(source, "ready", maxImages, [], {
        warnings: [
          {
            code: "selection_not_applicable",
            message: "The source artifact is already an image and does not have page, slide, sheet, or range selectors."
          }
        ]
      });
    }
    return success(
      source,
      "ready",
      maxImages,
      [
        {
          sourceArtifactId: source.id,
          imageArtifactId: source.id,
          mimeType: source.mimeType,
          status: "ready"
        }
      ],
      {
        warnings,
        artifacts: [
          {
            artifactId: source.id,
            kind: source.kind,
            mimeType: source.mimeType,
            filename: source.filename,
            modelVisibility: {
              type: "image",
              mimeType: source.mimeType
            },
            metadata: imageMetadata(source.id, {
              artifactId: source.id,
              mimeType: source.mimeType
            })
          }
        ]
      }
    );
  }

  const job = await options.store.getArtifactPreviewJob({
    clientInstanceId: context.clientInstanceId,
    sourceArtifactId: source.id,
    settingsHash
  });
  const manifest = await options.store.getArtifactPreviewManifest({
    clientInstanceId: context.clientInstanceId,
    sourceArtifactId: source.id,
    settingsHash
  });
  if (manifest) {
    if (manifest.status === "ready") {
      if (
        detectArtifactPreviewSourceKind(source) &&
        !readyCandidatesCoverSelection(previewCandidatesFromManifest(manifest), selection)
      ) {
        if (job && isActiveArtifactPreviewJob(job)) {
          return pendingPreviewImages(source, maxImages);
        }
        const queued = await queuePreviewJob(source, options.store, settingsHash, {
          replaceTerminal: true
        });
        return queuedPending(source, maxImages, queued.nextAttemptAt ?? queued.createdAt);
      }
      return previewStateFromManifest(source, manifest, selection, maxImages, context.clientInstanceId, options.store);
    }
    if (job && isActiveArtifactPreviewJob(job)) {
      return pendingPreviewImages(source, maxImages);
    }
    return previewStateFromManifest(source, manifest, selection, maxImages, context.clientInstanceId, options.store);
  }
  if (job && isActiveArtifactPreviewJob(job)) {
    return pendingPreviewImages(source, maxImages);
  }

  const embeddedPreview = readEmbeddedImagePagesPreview(source.metadata);
  if (embeddedPreview.length > 0) {
    if (
      detectArtifactPreviewSourceKind(source) &&
      !readyCandidatesCoverSelection(embeddedPreview, selection)
    ) {
      const queued = await queuePreviewJob(source, options.store, settingsHash, {
        replaceTerminal: true
      });
      return queuedPending(source, maxImages, queued.nextAttemptAt ?? queued.createdAt);
    }
    return previewStateFromReadyImages(
      source,
      embeddedPreview,
      selection,
      maxImages,
      context.clientInstanceId,
      options.store,
      [
        {
          code: "embedded_preview_snapshot",
          message: "Loaded preview images from the source artifact's bounded preview snapshot."
        }
      ]
    );
  }

  if (job) {
    if (job.settingsHash !== settingsHash && detectArtifactPreviewSourceKind(source)) {
      const queued = await queuePreviewJob(source, options.store, settingsHash);
      return queuedPending(source, maxImages, queued.nextAttemptAt ?? queued.createdAt);
    }
    if (job.status === "failed" || job.status === "unsupported") {
      return success(source, job.status, maxImages, [], {
        errorCode: job.errorCode,
        warnings: [
          {
            code: job.errorCode ?? job.status,
            message:
              job.status === "failed"
                ? "Preview image generation failed; no model-visible image parts were attached."
                : "This artifact type is not supported by the configured preview renderer."
          }
        ]
      });
    }
    if (job.status === "completed") {
      return success(source, "failed", maxImages, [], {
        errorCode: "preview_manifest_missing",
        warnings: [
          {
            code: "preview_manifest_missing",
            message: "Preview job completed but no ready preview manifest is available."
          }
        ]
      });
    }
    return success(source, "pending", maxImages, [], {
      warnings: [
        {
          code: "preview_pending",
          message: "Preview image generation is pending; no model-visible image parts were attached."
        }
      ]
    });
  }

  if (detectArtifactPreviewSourceKind(source)) {
    const queued = await queuePreviewJob(source, options.store, settingsHash);
    return queuedPending(source, maxImages, queued.nextAttemptAt ?? queued.createdAt);
  }

  return success(source, "unsupported", maxImages, [], {
    errorCode: "unsupported_type",
    warnings: [
      {
        code: "unsupported_type",
        message:
          "No ready preview images are available, and this artifact type is not supported by the configured preview renderer."
      }
    ]
  });
}

function pendingPreviewImages(
  source: ManagedArtifactRecord,
  maxImages: number
): ToolHandlerResult<WorkspacePreviewImagesOutput> {
  return success(source, "pending", maxImages, [], {
    warnings: [
      {
        code: "preview_pending",
        message: "Preview image generation is pending; no model-visible image parts were attached."
      }
    ]
  });
}

async function queuePreviewJob(
  source: ManagedArtifactRecord,
  store: WorkspacePreviewImagesStore,
  settingsHash: string,
  options: { replaceTerminal?: boolean } = {}
) {
  return store.enqueueArtifactPreviewJob({
    clientInstanceId: source.clientInstanceId,
    conversationId: source.conversationId,
    sourceArtifactId: source.id,
    sourceChecksum: source.checksum,
    sourceMimeType: source.mimeType,
    settingsHash,
    ...(options.replaceTerminal ? { replaceTerminal: true } : {})
  });
}

function queuedPending(
  source: ManagedArtifactRecord,
  maxImages: number,
  queuedAt: string
): ToolHandlerResult<WorkspacePreviewImagesOutput> {
  return success(source, "pending", maxImages, [], {
    warnings: [
      {
        code: "preview_pending",
        message: `Preview image generation was queued at ${queuedAt}; no model-visible image parts were attached yet.`
      }
    ]
  });
}

async function previewStateFromManifest(
  source: ManagedArtifactRecord,
  manifest: ArtifactPreviewManifest,
  selection: NormalizedSelection,
  maxImages: number,
  clientInstanceId: ClientInstanceId,
  store: WorkspacePreviewImagesStore
): Promise<ToolHandlerResult<WorkspacePreviewImagesOutput>> {
  if (manifest.status !== "ready") {
    return success(source, manifest.status, maxImages, [], {
      errorCode: manifest.errorCode,
      warnings: [
        {
          code: manifest.errorCode ?? manifest.status,
          message:
            manifest.status === "failed"
              ? "Preview image generation failed; no model-visible image parts were attached."
              : "This artifact type is not supported by the configured preview renderer."
        }
      ]
    });
  }

  const candidates = previewCandidatesFromManifest(manifest);
  return previewStateFromReadyImages(
    source,
    candidates,
    selection,
    maxImages,
    clientInstanceId,
    store
  );
}

function previewCandidatesFromManifest(manifest: ArtifactPreviewManifest): PreviewImageCandidate[] {
  if (manifest.status !== "ready") {
    return [];
  }
  return manifest.pages.flatMap((page) => {
    const mimeType = readSupportedImageMimeType(page.mimeType);
    return mimeType
      ? [
          {
            artifactId: page.artifactId,
            mimeType,
            pageNumber: page.pageNumber,
            slideNumber: page.slideNumber,
            sheet: page.sheet,
            range: page.range,
            width: page.width,
            height: page.height
          }
        ]
      : [];
  });
}

async function previewStateFromReadyImages(
  source: ManagedArtifactRecord,
  candidates: PreviewImageCandidate[],
  selection: NormalizedSelection,
  maxImages: number,
  clientInstanceId: ClientInstanceId,
  store: WorkspacePreviewImagesStore,
  initialWarnings: PreviewWarning[] = []
): Promise<ToolHandlerResult<WorkspacePreviewImagesOutput>> {
  const warnings = [...initialWarnings];
  addSelectionMetadataWarnings(candidates, selection, warnings);
  const selected = candidates.filter((candidate) => matchesSelection(candidate, selection));
  if (selection.hasSelection && selected.length === 0) {
    warnings.push({
      code: "selection_empty",
      message: "No ready preview images matched the requested page, slide, sheet, or range selectors."
    });
  }
  if (selected.length > maxImages) {
    warnings.push({
      code: "max_images_reached",
      message: `Only the first ${maxImages} matching preview images were attached.`
    });
  }

  const images: WorkspacePreviewImagesOutput["images"] = [];
  const artifacts: ManagedArtifactRef[] = [];
  const seenArtifactIds = new Set<string>();
  for (const candidate of selected) {
    if (images.length >= maxImages) {
      break;
    }
    if (seenArtifactIds.has(candidate.artifactId)) {
      continue;
    }
    seenArtifactIds.add(candidate.artifactId);
    const imageArtifact = await store.getManagedArtifact({
      clientInstanceId,
      artifactId: candidate.artifactId
    });
    if (!imageArtifact || imageArtifact.conversationId !== source.conversationId || imageArtifact.status !== "available") {
      warnings.push(previewImageWarning("preview_image_unavailable", "A selected preview image artifact is no longer available.", candidate));
      continue;
    }
    const mimeType = readSupportedImageMimeType(imageArtifact.mimeType);
    if (!mimeType || mimeType !== candidate.mimeType) {
      warnings.push(previewImageWarning("preview_image_mime_mismatch", "A selected preview image artifact has an unsupported or mismatched MIME type.", candidate));
      continue;
    }

    const metadata = imageMetadata(source.id, candidate);
    images.push({
      sourceArtifactId: source.id,
      imageArtifactId: imageArtifact.id,
      mimeType,
      status: "ready",
      ...(candidate.pageNumber ? { pageNumber: candidate.pageNumber } : {}),
      ...(candidate.slideNumber ? { slideNumber: candidate.slideNumber } : {}),
      ...(candidate.sheet ? { sheet: candidate.sheet } : {}),
      ...(candidate.range ? { range: candidate.range } : {}),
      ...(candidate.width ? { width: candidate.width } : {}),
      ...(candidate.height ? { height: candidate.height } : {})
    });
    artifacts.push({
      artifactId: imageArtifact.id,
      kind: imageArtifact.kind,
      mimeType,
      filename: imageArtifact.filename,
      modelVisibility: {
        type: "image",
        mimeType
      },
      metadata
    });
  }

  if (candidates.length > 0 && images.length === 0) {
    warnings.push({
      code: "no_attachable_preview_images",
      message: "Ready preview metadata exists, but no selected image artifacts could be attached to model context."
    });
  }

  return success(source, "ready", maxImages, images, {
    warnings,
    artifacts
  });
}

function success(
  source: ManagedArtifactRecord,
  status: WorkspacePreviewImagesOutput["status"],
  maxImages: number,
  images: WorkspacePreviewImagesOutput["images"],
  options: {
    warnings?: PreviewWarning[];
    errorCode?: string;
    artifacts?: ManagedArtifactRef[];
  } = {}
): ToolHandlerResult<WorkspacePreviewImagesOutput> {
  return toolSuccess(
    {
      artifactId: source.id,
      status,
      maxImages,
      images,
      warnings: options.warnings ?? [],
      ...(options.errorCode ? { errorCode: options.errorCode } : {})
    },
    {
      artifacts: options.artifacts && options.artifacts.length > 0 ? options.artifacts : undefined,
      auditSummary: {
        action: "workspace.preview_images",
        subject: source.id,
        metadata: {
          status,
          imageCount: images.length,
          maxImages,
          warningCount: options.warnings?.length ?? 0
        }
      }
    }
  );
}

function normalizeSelection(input: WorkspacePreviewImagesInput): NormalizedSelection {
  const pageNumbers = input.pages ? new Set(input.pages) : undefined;
  const slideNumbers = input.slides ? new Set(input.slides) : undefined;
  const sheets = input.sheets ? normalizedStringSet(input.sheets) : undefined;
  const ranges = input.ranges ? normalizedStringSet(input.ranges) : undefined;
  return {
    pageNumbers,
    slideNumbers,
    sheets,
    ranges,
    hasSelection: Boolean(pageNumbers?.size || slideNumbers?.size || sheets?.size || ranges?.size)
  };
}

function normalizePreviewImagesInput(
  input: WorkspacePreviewImagesInput
):
  | { ok: true; input: WorkspacePreviewImagesInput }
  | { ok: false; error: { message: string; details: JsonObject } } {
  if (!input.ranges?.length) {
    return { ok: true, input };
  }

  const canonicalRanges: string[] = [];
  const rangeSheets = new Set<string>();
  for (const range of input.ranges) {
    const parsed = splitSpreadsheetRangeSelector(range);
    const sheet = parsed.sheet ?? singleSheetSelector(input.sheets);
    if (!sheet) {
      return {
        ok: false,
        error: {
          message:
            "XLSX range selectors must include a sheet name or be paired with exactly one sheet selector",
          details: {
            range,
            sheets: input.sheets ?? [],
            example: "Summary!A1:B4"
          }
        }
      };
    }
    const canonical = `${quoteSpreadsheetSheetName(sheet)}!${parsed.range}`;
    canonicalRanges.push(canonical);
    rangeSheets.add(normalizeSelector(sheet));
  }

  const requestedSheets = input.sheets ? normalizedStringSet(input.sheets) : undefined;
  const missingRangeSheets = requestedSheets
    ? [...requestedSheets].filter((sheet) => !rangeSheets.has(sheet))
    : [];
  if (missingRangeSheets.length > 0) {
    return {
      ok: false,
      error: {
        message: "XLSX sheet selectors must match requested range sheets when ranges are provided",
        details: {
          sheets: input.sheets ?? [],
          ranges: input.ranges,
          missingRangeSheets
        }
      }
    };
  }

  return {
    ok: true,
    input: {
      ...input,
      ranges: canonicalRanges
    }
  };
}

function countRequestedPreviewImages(input: WorkspacePreviewImagesInput): number {
  return Math.max(
    input.pages?.length ?? 0,
    input.slides?.length ?? 0,
    input.ranges?.length ?? input.sheets?.length ?? 0,
    input.sheets?.length ?? 0
  );
}

function splitSpreadsheetRangeSelector(range: string): { sheet?: string; range: string } {
  const trimmed = range.trim();
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
        sheet: unquoteSpreadsheetSheetName(trimmed.slice(0, index)),
        range: trimmed.slice(index + 1).trim()
      };
    }
  }
  return { range: trimmed };
}

function singleSheetSelector(sheets: readonly string[] | undefined): string | undefined {
  return sheets?.length === 1 ? sheets[0]?.trim() : undefined;
}

function unquoteSpreadsheetSheetName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function quoteSpreadsheetSheetName(sheetName: string): string {
  return /^[A-Za-z0-9_]+$/u.test(sheetName) ? sheetName : `'${sheetName.replaceAll("'", "''")}'`;
}

function matchesSelection(candidate: PreviewImageCandidate, selection: NormalizedSelection): boolean {
  if (!selection.hasSelection) {
    return true;
  }
  return (
    (candidate.pageNumber !== undefined && selection.pageNumbers?.has(candidate.pageNumber)) ||
    (candidate.slideNumber !== undefined && selection.slideNumbers?.has(candidate.slideNumber)) ||
    (candidate.sheet !== undefined && selection.sheets?.has(normalizeSelector(candidate.sheet))) ||
    (candidate.range !== undefined && selection.ranges?.has(normalizeSelector(candidate.range))) ||
    false
  );
}

function readyCandidatesCoverSelection(
  candidates: PreviewImageCandidate[],
  selection: NormalizedSelection
): boolean {
  if (!selection.hasSelection) {
    return true;
  }
  return (
    coversAllNumbers(candidates, selection.pageNumbers, "pageNumber") &&
    coversAllNumbers(candidates, selection.slideNumbers, "slideNumber") &&
    coversAllStrings(candidates, selection.sheets, "sheet") &&
    coversAllStrings(candidates, selection.ranges, "range")
  );
}

function isActiveArtifactPreviewJob(job: ArtifactPreviewJobRecord): boolean {
  return job.status === "pending" || job.status === "processing";
}

function coversAllNumbers(
  candidates: PreviewImageCandidate[],
  values: Set<number> | undefined,
  key: "pageNumber" | "slideNumber"
): boolean {
  if (!values?.size) {
    return true;
  }
  return [...values].every((value) => candidates.some((candidate) => candidate[key] === value));
}

function coversAllStrings(
  candidates: PreviewImageCandidate[],
  values: Set<string> | undefined,
  key: "sheet" | "range"
): boolean {
  if (!values?.size) {
    return true;
  }
  return [...values].every((value) =>
    candidates.some((candidate) => {
      const candidateValue = candidate[key];
      return candidateValue !== undefined && normalizeSelector(candidateValue) === value;
    })
  );
}

function addSelectionMetadataWarnings(
  candidates: PreviewImageCandidate[],
  selection: NormalizedSelection,
  warnings: PreviewWarning[]
): void {
  if (selection.pageNumbers && candidates.every((candidate) => candidate.pageNumber === undefined)) {
    warnings.push({
      code: "page_metadata_unavailable",
      message: "Ready preview images do not include page-number metadata."
    });
  }
  if (selection.slideNumbers && candidates.every((candidate) => candidate.slideNumber === undefined)) {
    warnings.push({
      code: "slide_metadata_unavailable",
      message: "Ready preview images do not include slide-number metadata."
    });
  }
  if (selection.sheets && candidates.every((candidate) => candidate.sheet === undefined)) {
    warnings.push({
      code: "sheet_metadata_unavailable",
      message: "Ready preview images do not include sheet metadata."
    });
  }
  if (selection.ranges && candidates.every((candidate) => candidate.range === undefined)) {
    warnings.push({
      code: "range_metadata_unavailable",
      message: "Ready preview images do not include range metadata."
    });
  }
}

function readEmbeddedImagePagesPreview(metadata: JsonObject): PreviewImageCandidate[] {
  const preview = isRecord(metadata.preview) ? metadata.preview : undefined;
  if (preview?.type !== "image_pages" || !Array.isArray(preview.pages)) {
    return [];
  }
  return preview.pages.slice(0, 200).flatMap((page) => {
    const record = isRecord(page) ? page : undefined;
    const artifactId = typeof record?.artifactId === "string" ? record.artifactId : undefined;
    const mimeType = readSupportedImageMimeType(record?.mimeType);
    if (!artifactId || !mimeType) {
      return [];
    }
    return [
      {
        artifactId: asManagedArtifactId(artifactId),
        mimeType,
        pageNumber: readPositiveInteger(record?.pageNumber),
        slideNumber: readPositiveInteger(record?.slideNumber),
        sheet: readShortString(record?.sheet, 160),
        range: readShortString(record?.range, 160),
        width: readPositiveInteger(record?.width),
        height: readPositiveInteger(record?.height)
      }
    ];
  });
}

function imageMetadata(sourceArtifactId: ManagedArtifactId, candidate: PreviewImageCandidate): JsonObject {
  return {
    sourceArtifactId,
    status: "ready",
    ...(candidate.pageNumber ? { pageNumber: candidate.pageNumber } : {}),
    ...(candidate.slideNumber ? { slideNumber: candidate.slideNumber } : {}),
    ...(candidate.sheet ? { sheet: candidate.sheet } : {}),
    ...(candidate.range ? { range: candidate.range } : {}),
    ...(candidate.width ? { width: candidate.width } : {}),
    ...(candidate.height ? { height: candidate.height } : {})
  };
}

function previewImageWarning(
  code: string,
  message: string,
  candidate: PreviewImageCandidate
): PreviewWarning {
  return {
    code,
    message,
    ...(candidate.pageNumber ? { pageNumber: candidate.pageNumber } : {}),
    ...(candidate.slideNumber ? { slideNumber: candidate.slideNumber } : {}),
    ...(candidate.sheet ? { sheet: candidate.sheet } : {}),
    ...(candidate.range ? { range: candidate.range } : {})
  };
}

function normalizedStringSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeSelector));
}

function normalizeSelector(value: string): string {
  return value.trim().toLowerCase();
}

function readSupportedImageMimeType(value: unknown): SupportedImageMimeType | undefined {
  return typeof value === "string" && isSupportedImageMimeType(value) ? value : undefined;
}

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readShortString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
