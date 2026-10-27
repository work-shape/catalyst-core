import { z } from "zod";

/** A live file answer. The iterator is consumed by HTTP and never retained as run data. */
export interface DownloadAnswer {
  filename: string;
  contentType: string;
  body: AsyncIterable<string | Uint8Array>;
  /** Safe originals may open in a browser tab rather than be saved as an attachment. */
  inline?: boolean;
}
export const downloadAnswerSchema = z.custom<DownloadAnswer>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "filename" in value &&
    typeof value.filename === "string" &&
    "contentType" in value &&
    typeof value.contentType === "string" &&
    "body" in value &&
    typeof value.body === "object" &&
    value.body !== null &&
    Symbol.asyncIterator in value.body
);

// Types a browser shows without running anything on the API's origin. The type of a stored file
// comes from an upload, a capability or the agent, so HTML, SVG, XML and every other type a
// browser lays out as a document leave as an attachment, whoever asked to show them inline.
const INLINE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain"
]);

/**
 * Whether a file of this content type may be served `inline`. A value with a comma is refused:
 * a browser reads `image/png;x=1,text/html` as a list and takes its last type.
 */
export function displaysInline(contentType: string): boolean {
  const essence = /^\s*([^\s;,]+)\s*(?:;[^,]*)?$/u.exec(contentType)?.[1];
  return essence !== undefined && INLINE_CONTENT_TYPES.has(essence.toLowerCase());
}
