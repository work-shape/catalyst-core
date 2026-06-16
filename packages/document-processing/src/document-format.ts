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

export function unsupportedDocumentUploadReason(input: {
  filename: string;
  format: DocumentFileFormat | undefined;
  bytes: Uint8Array;
}): string | undefined {
  if (isWordTemporaryOwnerFile(input.filename)) {
    return "Microsoft Word temporary owner files are not readable documents. Upload the original .docx file instead of the '~$' lock file.";
  }
  if (input.format === "docx" && !hasDocxZipPackageSignature(input.bytes)) {
    return "The file is marked as DOCX but is not a valid Word document package. Upload the original .docx file.";
  }
  return undefined;
}

export function hasDocxZipPackageSignature(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isWordTemporaryOwnerFile(filename: string): boolean {
  const basename = filename.split(/[\\/]/u).pop() ?? filename;
  return basename.startsWith("~$") && extensionFromFilename(basename) === "docx";
}
