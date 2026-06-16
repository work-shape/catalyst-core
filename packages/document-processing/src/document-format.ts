import type {
  DocumentFileFormat,
  FileAttachmentFormat,
  ImageFileFormat,
  SupportedImageMimeType
} from "@vivd-catalyst/core";

const TEXT_MIME_TYPES = new Set(["text/plain"]);
const MARKDOWN_MIME_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const PDF_MIME_TYPES = new Set(["application/pdf"]);
const DOCX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
const IMAGE_MIME_TYPES: Record<SupportedImageMimeType, ImageFileFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif"
};

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

export function detectAttachmentFormat(
  filename: string,
  mimeType: string | undefined
): FileAttachmentFormat | undefined {
  return detectImageFileFormat(filename, mimeType) ?? detectDocumentFormat(filename, mimeType);
}

export function detectImageFileFormat(
  filename: string,
  mimeType: string | undefined
): ImageFileFormat | undefined {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (normalizedMimeType && isSupportedImageMimeType(normalizedMimeType)) {
    return IMAGE_MIME_TYPES[normalizedMimeType];
  }

  const extension = extensionFromFilename(filename);
  if (extension === "png" || extension === "webp" || extension === "gif") {
    return extension;
  }
  if (extension === "jpg" || extension === "jpeg") {
    return "jpeg";
  }
  return undefined;
}

export function extensionFromFilename(filename: string): string | undefined {
  return filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
}

export function unsupportedDocumentUploadReason(input: {
  filename: string;
  format: FileAttachmentFormat | undefined;
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

export function unsupportedImageUploadReason(input: {
  format: ImageFileFormat;
  bytes: Uint8Array;
}): string | undefined {
  if (!hasImageFileSignature(input.format, input.bytes)) {
    return `The file is marked as ${input.format.toUpperCase()} but does not match that image format.`;
  }
  return undefined;
}

export function isImageFileFormat(
  format: FileAttachmentFormat | undefined
): format is ImageFileFormat {
  return format === "png" || format === "jpeg" || format === "webp" || format === "gif";
}

export function isDocumentFileFormat(
  format: FileAttachmentFormat | undefined
): format is DocumentFileFormat {
  return format === "pdf" || format === "docx" || format === "txt" || format === "md";
}

export function imageMimeTypeForFormat(format: ImageFileFormat): SupportedImageMimeType {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
  }
}

export function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

export function hasDocxZipPackageSignature(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function hasImageFileSignature(format: ImageFileFormat, bytes: Uint8Array): boolean {
  if (format === "png") {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (format === "jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (format === "gif") {
    const header = new TextDecoder("ascii", { fatal: false }).decode(bytes.slice(0, 6));
    return header === "GIF87a" || header === "GIF89a";
  }
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function isWordTemporaryOwnerFile(filename: string): boolean {
  const basename = filename.split(/[\\/]/u).pop() ?? filename;
  return basename.startsWith("~$") && extensionFromFilename(basename) === "docx";
}

function normalizeMimeType(mimeType: string | undefined): string | undefined {
  return mimeType?.split(";")[0]?.trim().toLowerCase();
}
