import type { DocumentFileFormat } from "@vivd-catalyst/core";

const TEXT_MIME_TYPES = new Set(["text/plain"]);
const MARKDOWN_MIME_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const PDF_MIME_TYPES = new Set(["application/pdf"]);
const DOCX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);

export function detectDocumentFormat(
  filename: string,
  mimeType: string | undefined
): DocumentFileFormat | undefined {
  const normalizedMimeType = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (normalizedMimeType && PDF_MIME_TYPES.has(normalizedMimeType)) {
    return "pdf";
  }
  if (normalizedMimeType && DOCX_MIME_TYPES.has(normalizedMimeType)) {
    return "docx";
  }
  if (normalizedMimeType && TEXT_MIME_TYPES.has(normalizedMimeType)) {
    return "txt";
  }
  if (normalizedMimeType && MARKDOWN_MIME_TYPES.has(normalizedMimeType)) {
    return "md";
  }

  const extension = extensionFromFilename(filename);
  if (extension === "pdf" || extension === "docx" || extension === "txt" || extension === "md") {
    return extension;
  }
  if (extension === "markdown") {
    return "md";
  }
  return undefined;
}

export function extensionFromFilename(filename: string): string | undefined {
  return filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
}
