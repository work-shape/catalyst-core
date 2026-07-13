import type { ArtifactPreviewResponse } from "@vivd-catalyst/api-client";

export const WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE = "data-workspace-promoted-artifacts";

export type ToolArtifactPreviewSnapshot = Extract<ArtifactPreviewResponse, { status: "ready" }>;

export interface ToolArtifactDownloadRef {
  artifactId: string;
  kind?: string;
  filename?: string;
  mimeType?: string;
  metadata?: ToolArtifactMetadata;
  preview?: ToolArtifactPreviewSnapshot;
}

export interface ToolArtifactMetadata {
  preview?: ToolArtifactImagePagesPreview;
}

export interface ToolArtifactImagePagesPreview {
  type: "image_pages";
  format: "png" | "jpeg" | "webp" | "gif";
  pages: ToolArtifactPreviewImagePageRef[];
}

export interface ToolArtifactPreviewImagePageRef {
  artifactId: string;
  kind?: string;
  filename?: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  pageNumber?: number;
  slideNumber?: number;
  width?: number;
  height?: number;
}

export interface WorkspacePromotedArtifactsData {
  kind: "workspace.promoted_artifacts";
  artifacts: ToolArtifactDownloadRef[];
}

export interface ArtifactFileType {
  badge: string;
  label: string;
  className: string;
  extension: string;
}

export type ArtifactPreviewKind =
  | "pdf"
  | "image"
  | "markdown"
  | "text"
  | "spreadsheet"
  | "image-pages"
  | "document"
  | "presentation";

export function createWorkspacePromotedArtifactsData(
  artifacts: ToolArtifactDownloadRef[]
): WorkspacePromotedArtifactsData {
  return {
    kind: "workspace.promoted_artifacts",
    artifacts: dedupeToolArtifactRefs(artifacts)
  };
}

export function isWorkspacePromotedArtifactsData(
  value: unknown
): value is WorkspacePromotedArtifactsData {
  const data = isRecord(value) ? value : undefined;
  return readWorkspacePromotedArtifactsData(data) !== undefined;
}

export function readWorkspacePromotedArtifactsData(
  value: unknown
): WorkspacePromotedArtifactsData | undefined {
  const data = isRecord(value) ? value : undefined;
  if (data?.kind !== "workspace.promoted_artifacts") {
    return undefined;
  }
  const artifacts = readArtifactArray(data.artifacts);
  return artifacts.length > 0
    ? {
        kind: "workspace.promoted_artifacts",
        artifacts
      }
    : undefined;
}

export function readToolArtifactRefs(result: unknown): ToolArtifactDownloadRef[] {
  const container = isRecord(result) ? result : undefined;
  return readArtifactArray(container?.artifacts);
}

export function readSurfacedToolArtifactRefs(
  result: unknown,
  toolName: string
): ToolArtifactDownloadRef[] {
  if (toolName === "workspace.promote_artifact" || toolName === "workspace.exec") {
    return readToolArtifactRefs(result);
  }
  return [];
}

export function dedupeToolArtifactRefs(
  artifacts: ToolArtifactDownloadRef[]
): ToolArtifactDownloadRef[] {
  const seen = new Set<string>();
  const unique: ToolArtifactDownloadRef[] = [];
  for (const artifact of artifacts) {
    const sanitized = sanitizeToolArtifactRef(artifact);
    if (!sanitized || seen.has(sanitized.artifactId)) {
      continue;
    }
    seen.add(sanitized.artifactId);
    unique.push(sanitized);
  }
  return unique;
}

export function getArtifactFileType(artifact: ToolArtifactDownloadRef): ArtifactFileType {
  const value = artifactDescriptorValue(artifact);
  if (value.includes("pdf") || hasExtension(value, ["pdf"])) {
    return { badge: "PDF", label: "PDF", className: "bg-red-700", extension: "pdf" };
  }
  if (value.includes("presentation") || hasExtension(value, ["pptx", "ppt"])) {
    return { badge: "PPT", label: "Presentation", className: "bg-orange-700", extension: "pptx" };
  }
  if (
    value.includes("wordprocessingml") ||
    value.includes("msword") ||
    value.includes("word") ||
    hasExtension(value, ["docx", "doc"])
  ) {
    return { badge: "DOC", label: "Word document", className: "bg-blue-700", extension: "docx" };
  }
  if (value.includes("csv") || hasExtension(value, ["csv"])) {
    return { badge: "CSV", label: "CSV", className: "bg-teal-700", extension: "csv" };
  }
  if (
    value.includes("spreadsheet") ||
    value.includes("excel") ||
    hasExtension(value, ["xlsx", "xls"])
  ) {
    return { badge: "XLS", label: "Spreadsheet", className: "bg-emerald-700", extension: "xlsx" };
  }
  if (value.includes("image") || hasExtension(value, ["png", "jpg", "jpeg", "webp", "gif", "svg"])) {
    return { badge: "IMG", label: "Image", className: "bg-violet-700", extension: "png" };
  }
  if (
    value.includes("zip") ||
    value.includes("compressed") ||
    value.includes("archive") ||
    hasExtension(value, ["zip", "tar", "gz", "tgz", "rar", "7z"])
  ) {
    return { badge: "ZIP", label: "Archive", className: "bg-stone-700", extension: "zip" };
  }
  if (
    value.includes("markdown") ||
    hasExtension(value, ["md", "mdx"])
  ) {
    return { badge: "MD", label: "Markdown", className: "bg-slate-700", extension: "md" };
  }
  if (
    value.includes("text/") ||
    value.includes("json") ||
    hasExtension(value, ["txt", "rtf", "html", "json"])
  ) {
    return { badge: "DOC", label: "Document", className: "bg-slate-700", extension: "txt" };
  }
  return { badge: "FILE", label: "File", className: "bg-neutral-700", extension: "bin" };
}

export function getArtifactPreviewKind(artifact: ToolArtifactDownloadRef): ArtifactPreviewKind | undefined {
  if (readArtifactImagePagesPreview(artifact)) {
    return "image-pages";
  }
  const value = artifactDescriptorValue(artifact);
  const fileType = getArtifactFileType(artifact);
  if (fileType.extension === "pdf") {
    return "pdf";
  }
  if (isOfficeDocumentPreviewCandidate(value)) {
    return "document";
  }
  if (isOfficePresentationPreviewCandidate(value)) {
    return "presentation";
  }
  if (fileType.label === "Image") {
    return "image";
  }
  if (fileType.extension === "md") {
    return "markdown";
  }
  if (fileType.extension === "txt" || fileType.extension === "csv") {
    return "text";
  }
  if (fileType.extension === "xlsx") {
    return "spreadsheet";
  }
  return undefined;
}

export function readArtifactImagePagesPreview(
  artifact: ToolArtifactDownloadRef
): ToolArtifactImagePagesPreview | undefined {
  return artifact.metadata?.preview ?? previewSnapshotToImagePagesPreview(artifact.preview);
}

function artifactDescriptorValue(artifact: ToolArtifactDownloadRef): string {
  return `${artifact.mimeType ?? ""} ${artifact.kind ?? ""} ${artifact.filename ?? ""}`.toLowerCase();
}

function isOfficeDocumentPreviewCandidate(value: string): boolean {
  return (
    value.includes("wordprocessingml") ||
    hasExtension(value, ["docx"])
  );
}

function isOfficePresentationPreviewCandidate(value: string): boolean {
  return (
    value.includes("presentationml") ||
    hasExtension(value, ["pptx"])
  );
}

export function artifactDisplayFilename(artifact: ToolArtifactDownloadRef): string {
  return artifact.filename ?? `${getArtifactFileType(artifact).label} artifact`;
}

export function artifactDownloadFilename(artifact: ToolArtifactDownloadRef): string {
  return artifact.filename ?? `artifact.${getArtifactFileType(artifact).extension}`;
}

function readArtifactArray(value: unknown): ToolArtifactDownloadRef[] {
  const rawArtifacts = Array.isArray(value) ? value : [];
  return rawArtifacts.flatMap((artifact): ToolArtifactDownloadRef[] =>
    isRecord(artifact) ? maybeOne(sanitizeToolArtifactRef(artifact)) : []
  );
}

function sanitizeToolArtifactRef(artifact: {
  artifactId?: unknown;
  kind?: unknown;
  filename?: unknown;
  mimeType?: unknown;
  metadata?: unknown;
}): ToolArtifactDownloadRef | undefined {
  const artifactId = typeof artifact.artifactId === "string" ? artifact.artifactId : undefined;
  if (!artifactId || artifactId.length > 200) {
    return undefined;
  }

  const ref: ToolArtifactDownloadRef = {
    artifactId
  };
  const kind = readSafeArtifactKind(artifact.kind);
  if (kind) {
    ref.kind = kind;
  }
  const filename = readDisplayFilename(artifact.filename);
  if (filename) {
    ref.filename = filename;
  }
  const mimeType = readSafeMimeType(artifact.mimeType);
  if (mimeType) {
    ref.mimeType = mimeType;
  }
  const metadata = sanitizeToolArtifactMetadata(artifact.metadata);
  if (metadata) {
    ref.metadata = metadata;
  }
  const preview = readSafePreviewSnapshot(artifact.metadata, artifactId);
  if (preview) {
    ref.preview = preview;
  }
  return ref;
}

function sanitizeToolArtifactMetadata(value: unknown): ToolArtifactMetadata | undefined {
  const record = isRecord(value) ? value : undefined;
  const preview = sanitizeImagePagesPreview(record?.preview);
  return preview ? { preview } : undefined;
}

function sanitizeImagePagesPreview(value: unknown): ToolArtifactImagePagesPreview | undefined {
  const record = isRecord(value) ? value : undefined;
  if (record?.type !== "image_pages") {
    return undefined;
  }
  const format = readSafeImageFormat(record.format);
  if (!format) {
    return undefined;
  }
  const pages = Array.isArray(record.pages)
    ? record.pages.slice(0, 200).flatMap((page): ToolArtifactPreviewImagePageRef[] => {
        const sanitized = sanitizePreviewImagePage(page);
        return sanitized ? [sanitized] : [];
      })
    : [];
  return pages.length > 0 ? { type: "image_pages", format, pages } : undefined;
}

function sanitizePreviewImagePage(value: unknown): ToolArtifactPreviewImagePageRef | undefined {
  const record = isRecord(value) ? value : undefined;
  const artifactId = readSafeManagedArtifactId(record?.artifactId);
  const mimeType = readSafeImageMimeType(record?.mimeType);
  if (!artifactId || !mimeType) {
    return undefined;
  }
  const ref: ToolArtifactPreviewImagePageRef = {
    artifactId,
    mimeType
  };
  const kind = readSafeArtifactKind(record?.kind);
  if (kind) {
    ref.kind = kind;
  }
  const filename = readDisplayFilename(record?.filename);
  if (filename) {
    ref.filename = filename;
  }
  const pageNumber = readSafeOrdinal(record?.pageNumber);
  if (pageNumber !== undefined) {
    ref.pageNumber = pageNumber;
  }
  const slideNumber = readSafeOrdinal(record?.slideNumber);
  if (slideNumber !== undefined) {
    ref.slideNumber = slideNumber;
  }
  const width = readSafeOrdinal(record?.width);
  if (width !== undefined) {
    ref.width = width;
  }
  const height = readSafeOrdinal(record?.height);
  if (height !== undefined) {
    ref.height = height;
  }
  return ref;
}

function previewSnapshotToImagePagesPreview(
  preview: ToolArtifactPreviewSnapshot | undefined
): ToolArtifactImagePagesPreview | undefined {
  if (!preview || preview.type !== "image_pages") {
    return undefined;
  }
  return {
    type: "image_pages",
    format: preview.format,
    pages: preview.pages.map((page) => ({
      artifactId: page.artifactId,
      ...(page.filename ? { filename: page.filename } : {}),
      mimeType: page.mimeType,
      ...(page.pageNumber ? { pageNumber: page.pageNumber } : {}),
      ...(page.slideNumber ? { slideNumber: page.slideNumber } : {}),
      ...(page.width ? { width: page.width } : {}),
      ...(page.height ? { height: page.height } : {})
    }))
  };
}

function readSafePreviewSnapshot(
  metadataValue: unknown,
  sourceArtifactId: string
): ToolArtifactPreviewSnapshot | undefined {
  const metadata = isRecord(metadataValue) ? metadataValue : undefined;
  const preview = isRecord(metadata?.preview) ? metadata.preview : undefined;
  if (preview?.status !== undefined && preview.status !== "ready") {
    return undefined;
  }
  const sanitized = sanitizeImagePagesPreview(preview);
  if (!sanitized || sanitized.format === "gif") {
    return undefined;
  }
  const pages = sanitized.pages.flatMap((page): ToolArtifactPreviewSnapshot["pages"] => {
    if (page.mimeType === "image/gif") {
      return [];
    }
    return [
      {
        artifactId: page.artifactId,
        mimeType: page.mimeType,
        ...(page.filename ? { filename: page.filename } : {}),
        ...(page.pageNumber ? { pageNumber: page.pageNumber } : {}),
        ...(page.slideNumber ? { slideNumber: page.slideNumber } : {}),
        ...(page.width ? { width: page.width } : {}),
        ...(page.height ? { height: page.height } : {})
      }
    ];
  });
  return pages.length > 0
    ? {
        status: "ready",
        artifactId: sourceArtifactId,
        type: "image_pages",
        format: sanitized.format,
        pages
      }
    : undefined;
}

function maybeOne<T>(value: T | undefined): T[] {
  return value === undefined ? [] : [value];
}

function readDisplayFilename(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const basename = normalized.split("/").at(-1)?.trim();
  if (!basename || basename === "." || basename === ".." || isInternalIdentifier(basename)) {
    return undefined;
  }
  return basename.length > 120 ? `${basename.slice(0, 117)}...` : basename;
}

function readSafeArtifactKind(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 100) {
    return undefined;
  }
  if (isSafeMimeType(value)) {
    return value;
  }
  return /^[a-z0-9][a-z0-9_.:-]*$/iu.test(value) && !isInternalIdentifier(value) ? value : undefined;
}

function readSafeMimeType(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 120) {
    return undefined;
  }
  return isSafeMimeType(value) ? value : undefined;
}

function readSafeImageMimeType(value: unknown): ToolArtifactPreviewImagePageRef["mimeType"] | undefined {
  const mimeType = readSafeMimeType(value);
  return mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/webp" ||
    mimeType === "image/gif"
    ? mimeType
    : undefined;
}

function readSafeImageFormat(value: unknown): ToolArtifactImagePagesPreview["format"] | undefined {
  return value === "png" || value === "jpeg" || value === "webp" || value === "gif"
    ? value
    : undefined;
}

function readSafeOrdinal(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 10_000
    ? value
    : undefined;
}

function readSafeManagedArtifactId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200 || value.trim() !== value) {
    return undefined;
  }
  return /^art_[a-z0-9][a-z0-9_-]*$/iu.test(value) ? value : undefined;
}

function isSafeMimeType(value: string): boolean {
  return /^(?:application|audio|font|image|message|model|multipart|text|video)\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value);
}

function hasExtension(value: string, extensions: string[]): boolean {
  return extensions.some((extension) => new RegExp(`\\.${escapeRegExp(extension)}(?:\\s|$)`, "iu").test(value));
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isInternalIdentifier(value: string): boolean {
  return /^(?:file|art|ews|wcmd)_[a-z0-9_-]+$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
