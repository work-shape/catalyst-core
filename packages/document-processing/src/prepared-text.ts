import type { DocumentAttachmentWarning } from "@vivd-catalyst/core";

const UNSUPPORTED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

export function sanitizePreparedText(
  text: string
): {
  text: string;
  warnings: DocumentAttachmentWarning[];
} {
  if (!UNSUPPORTED_CONTROL_CHARACTERS.test(text)) {
    return { text, warnings: [] };
  }

  UNSUPPORTED_CONTROL_CHARACTERS.lastIndex = 0;
  return {
    text: text.replace(UNSUPPORTED_CONTROL_CHARACTERS, ""),
    warnings: [
      {
        code: "control_characters_removed",
        message: "Unsupported control characters were removed from the extracted text."
      }
    ]
  };
}

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
