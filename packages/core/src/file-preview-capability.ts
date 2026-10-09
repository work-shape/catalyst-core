import type { ArtifactPreviewSourceKind, FilePreviewCapability } from "./files";

export function detectArtifactPreviewSourceKind(input: {
  filename?: string;
  kind?: string;
  mimeType?: string;
}): ArtifactPreviewSourceKind | undefined {
  const capability = resolveFilePreviewCapability(input);
  return capability === "native_pdf"
    ? "pdf"
    : capability === "office_presentation_pages"
      ? "presentation"
      : capability === "office_document_pages"
        ? "document"
        : capability === "spreadsheet"
          ? "spreadsheet"
          : undefined;
}

/** Selects preview behavior from the file itself, independent of how it entered the conversation. */
export function resolveFilePreviewCapability(input: {
  filename?: string;
  kind?: string;
  mimeType?: string;
}): FilePreviewCapability | undefined {
  const descriptor =
    `${input.mimeType ?? ""} ${input.kind ?? ""} ${input.filename ?? ""}`.toLowerCase();
  if (containsPdfSignal(descriptor)) {
    return "native_pdf";
  }
  if (containsOfficePresentationSignal(descriptor)) {
    return "office_presentation_pages";
  }
  if (containsOfficeDocumentSignal(descriptor)) {
    return "office_document_pages";
  }
  if (containsSpreadsheetSignal(descriptor)) {
    return "spreadsheet";
  }
  if (
    input.mimeType?.toLowerCase().startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|svg)$/iu.test(input.filename ?? "")
  ) {
    return "native_image";
  }
  if (descriptor.includes("markdown") || hasArtifactPreviewExtension(descriptor, ["md", "mdx"])) {
    return "markdown";
  }
  if (
    input.mimeType?.toLowerCase().startsWith("text/") ||
    descriptor.includes("application/json") ||
    hasArtifactPreviewExtension(descriptor, ["txt", "csv", "json", "html", "rtf"])
  ) {
    return "text";
  }
  return undefined;
}

function containsPdfSignal(descriptor: string): boolean {
  return descriptor.includes("application/pdf") || hasArtifactPreviewExtension(descriptor, ["pdf"]);
}

function containsOfficePresentationSignal(descriptor: string): boolean {
  return (
    descriptor.includes("presentationml") ||
    descriptor.includes("powerpoint") ||
    hasArtifactPreviewExtension(descriptor, ["pptx", "ppt"])
  );
}

function containsOfficeDocumentSignal(descriptor: string): boolean {
  return (
    descriptor.includes("wordprocessingml") ||
    descriptor.includes("msword") ||
    hasArtifactPreviewExtension(descriptor, ["docx", "doc"])
  );
}

function containsSpreadsheetSignal(descriptor: string): boolean {
  return (
    descriptor.includes("spreadsheetml") ||
    descriptor.includes("ms-excel") ||
    descriptor.includes("msexcel") ||
    descriptor.includes("opendocument.spreadsheet") ||
    descriptor.includes("spreadsheet") ||
    hasArtifactPreviewExtension(descriptor, ["xlsx", "xlsm", "xls", "ods"])
  );
}

function hasArtifactPreviewExtension(descriptor: string, extensions: string[]): boolean {
  return extensions.some((extension) =>
    new RegExp(`(^|[^a-z0-9])${extension}([^a-z0-9]|$)`, "iu").test(descriptor)
  );
}
