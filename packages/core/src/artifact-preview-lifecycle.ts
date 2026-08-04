import {
  normalizeArtifactPreviewIdentity,
  isImageFileFormat,
  type ArtifactPreviewImageFormat,
  type ArtifactPreviewImagePageRef,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewManifest,
  type ArtifactPreviewStore,
  type ImageFileFormat,
  type SupportedImageMimeType
} from "./types";
import type { ClientInstanceId, ManagedArtifactId } from "./ids";
import type { JsonObject } from "./json";

export type ArtifactPreviewLifecycleState =
  | {
      status: "ready";
      source: "manifest" | "embedded";
      format?: ImageFileFormat;
      pages: ArtifactPreviewLifecyclePageRef[];
      pageCount?: number;
      activeQueuedAt?: string;
    }
  | { status: "active"; queuedAt: string }
  | { status: "failed"; errorCode?: string }
  | { status: "unsupported"; errorCode?: string }
  | { status: "missing"; completedWithoutManifest: boolean };

export interface ArtifactPreviewLifecyclePageRef {
  artifactId: ManagedArtifactId;
  mimeType: SupportedImageMimeType;
  filename?: string;
  pageNumber?: number;
  slideNumber?: number;
  sheet?: string;
  range?: string;
  width?: number;
  height?: number;
}

export interface ArtifactPreviewContractReady {
  format: ArtifactPreviewImageFormat;
  pages: ArtifactPreviewImagePageRef[];
}

export type ArtifactPreviewLifecycleStore = Pick<
  ArtifactPreviewStore,
  "getArtifactPreviewJob" | "getArtifactPreviewManifest"
>;

export async function readArtifactPreviewLifecycle(
  store: ArtifactPreviewLifecycleStore,
  input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
    metadata?: JsonObject;
    renderer?: string;
    rendererVersion?: string;
    settingsHash?: string;
  }
): Promise<ArtifactPreviewLifecycleState> {
  const identity = normalizeArtifactPreviewIdentity(input);
  const [job, manifest] = await Promise.all([
    store.getArtifactPreviewJob({
      clientInstanceId: input.clientInstanceId,
      sourceArtifactId: input.sourceArtifactId,
      ...identity
    }),
    store.getArtifactPreviewManifest({
      clientInstanceId: input.clientInstanceId,
      sourceArtifactId: input.sourceArtifactId,
      ...identity
    })
  ]);
  return resolveArtifactPreviewLifecycle({ job, manifest, metadata: input.metadata });
}

export function resolveArtifactPreviewLifecycle(input: {
  job?: ArtifactPreviewJobRecord;
  manifest?: ArtifactPreviewManifest;
  metadata?: JsonObject;
}): ArtifactPreviewLifecycleState {
  if (input.manifest?.status === "ready") {
    return {
      status: "ready",
      source: "manifest",
      format: input.manifest.format,
      pageCount: input.manifest.pageCount,
      pages: input.manifest.pages.map(sanitizePreviewPage).filter(isDefined),
      ...(isActive(input.job)
        ? { activeQueuedAt: input.job.nextAttemptAt ?? input.job.createdAt }
        : {})
    };
  }
  if (isActive(input.job)) {
    return {
      status: "active",
      queuedAt: input.job.nextAttemptAt ?? input.job.createdAt
    };
  }
  if (input.manifest) {
    return { status: input.manifest.status, errorCode: input.manifest.errorCode };
  }

  const embedded = readEmbeddedArtifactPreview(input.metadata);
  if (embedded) {
    return embedded;
  }
  if (input.job?.status === "failed" || input.job?.status === "unsupported") {
    return { status: input.job.status, errorCode: input.job.errorCode };
  }
  return {
    status: "missing",
    completedWithoutManifest: input.job?.status === "completed"
  };
}

export function asArtifactPreviewContractReady(
  preview: Extract<ArtifactPreviewLifecycleState, { status: "ready" }>
): ArtifactPreviewContractReady | undefined {
  const format = readPreviewFormat(preview.format);
  if (!format) {
    return undefined;
  }
  const pages = preview.pages.flatMap((page) =>
    page.mimeType === "image/gif" ? [] : [page as ArtifactPreviewImagePageRef]
  );
  return pages.length > 0 ? { format, pages } : undefined;
}

function isActive(
  job: ArtifactPreviewJobRecord | undefined
): job is ArtifactPreviewJobRecord & { status: "pending" | "processing" } {
  return job?.status === "pending" || job?.status === "processing";
}

function readEmbeddedArtifactPreview(
  metadata: JsonObject | undefined
): Extract<ArtifactPreviewLifecycleState, { status: "ready" }> | undefined {
  const preview = isRecord(metadata?.preview) ? metadata.preview : undefined;
  if (preview?.type !== "image_pages" || !Array.isArray(preview.pages)) {
    return undefined;
  }
  const pages = preview.pages.slice(0, 200).map(sanitizePreviewPage).filter(isDefined);
  return pages.length > 0
    ? {
        status: "ready",
        source: "embedded",
        ...(typeof preview.format === "string" && isImageFileFormat(preview.format)
          ? { format: preview.format }
          : {}),
        pages
      }
    : undefined;
}

function sanitizePreviewPage(value: unknown): ArtifactPreviewLifecyclePageRef | undefined {
  const page = isRecord(value) ? value : undefined;
  const artifactId = readShortString(page?.artifactId, 200);
  const mimeType = readPreviewMimeType(page?.mimeType);
  if (!artifactId || !mimeType) {
    return undefined;
  }
  const filename = readShortString(page?.filename, 255);
  const sheet = readShortString(page?.sheet, 160);
  const range = readShortString(page?.range, 160);
  const pageNumber = readPositiveInteger(page?.pageNumber);
  const slideNumber = readPositiveInteger(page?.slideNumber);
  const width = readPositiveInteger(page?.width);
  const height = readPositiveInteger(page?.height);
  return {
    artifactId: artifactId as ManagedArtifactId,
    mimeType,
    ...(filename ? { filename } : {}),
    ...(pageNumber ? { pageNumber } : {}),
    ...(slideNumber ? { slideNumber } : {}),
    ...(sheet ? { sheet } : {}),
    ...(range ? { range } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {})
  };
}

function readPreviewFormat(value: unknown): ArtifactPreviewImageFormat | undefined {
  return value === "png" || value === "jpeg" || value === "webp" ? value : undefined;
}

function readPreviewMimeType(value: unknown): SupportedImageMimeType | undefined {
  return value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/gif"
    ? value
    : undefined;
}

function readShortString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}
