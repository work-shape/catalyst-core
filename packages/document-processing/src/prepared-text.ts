import type { DocumentAttachmentWarning } from "@vivd-catalyst/core";

export function boundPreparedText(
  text: string,
  maxBytes: number
): {
  text: string;
  warnings: DocumentAttachmentWarning[];
} {
  if (byteLength(text) <= maxBytes) {
    return { text, warnings: [] };
  }

  let bounded = text.slice(0, maxBytes);
  while (byteLength(bounded) > maxBytes && bounded.length > 0) {
    bounded = bounded.slice(0, -1024);
  }
  return {
    text: bounded,
    warnings: [
      {
        code: "text_truncated",
        message: "Extracted text was truncated at the configured prepared text limit."
      }
    ]
  };
}

export function countWords(text: string): number {
  const words = text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu);
  return words?.length ?? 0;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
