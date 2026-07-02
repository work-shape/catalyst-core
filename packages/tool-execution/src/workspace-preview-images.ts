import type { z } from "zod";
import {
  asManagedArtifactId,
  detectArtifactPreviewSourceKind,
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
  const selection = normalizeSelection(input);
  const settingsHash = createArtifactPreviewSettingsHash({
    pages: input.pages,
    slides: input.slides,
    sheets: input.sheets,
    ranges: input.ranges,
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

  const manifest = await options.store.getArtifactPreviewManifest({
    clientInstanceId: context.clientInstanceId,
    sourceArtifactId: source.id
  });
  if (manifest) {
    return previewStateFromManifest(source, manifest, selection, maxImages, context.clientInstanceId, options.store);
  }

  const embeddedPreview = readEmbeddedImagePagesPreview(source.metadata);
  if (embeddedPreview.length > 0) {
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

  const job = await options.store.getArtifactPreviewJob({
    clientInstanceId: context.clientInstanceId,
    sourceArtifactId: source.id
  });
  if (job) {
    if (job.settingsHash !== settingsHash && detectArtifactPreviewSourceKind(source)) {
      const queued = await queuePreviewJob(source, options.store, settingsHash);
      return queuedPending(source, maxImages, queued.createdAt);
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
    return queuedPending(source, maxImages, queued.createdAt);
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

async function queuePreviewJob(
  source: ManagedArtifactRecord,
  store: WorkspacePreviewImagesStore,
  settingsHash: string
) {
  return store.enqueueArtifactPreviewJob({
    clientInstanceId: source.clientInstanceId,
    conversationId: source.conversationId,
    sourceArtifactId: source.id,
    sourceChecksum: source.checksum,
    sourceMimeType: source.mimeType,
    settingsHash
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

  return previewStateFromReadyImages(
    source,
    manifest.pages.flatMap((page) => {
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
    }),
    selection,
    maxImages,
    clientInstanceId,
    store
  );
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
