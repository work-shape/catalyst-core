import type { InlineMailImage } from "../types";

// The instance's logo, read once from where the release config points (`branding.logoUrl`)
// and carried inside every mail of `mail.send`. The mail itself never loads it from a host.
// Only PNG, JPEG and GIF are carried, as mail clients show no SVG; anything else, or a logo
// that cannot be read, leaves the frame with the instance's name alone.

/** The largest logo a mail carries. */
export const MAIL_LOGO_MAX_BYTES = 256 * 1024;
const LOGO_READ_TIMEOUT_MS = 5_000;
/** A logo that could not be read is asked for again after this long. */
const LOGO_RETRY_MS = 5 * 60_000;

export interface InlineImageLoaderOptions {
  /** Absolute, or a path resolved against `baseUrl`. */
  url: string;
  baseUrl?: string;
  contentId: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Reads the image once and keeps it; a failure is kept for a while and then read again. */
export function createInlineImageLoader(
  options: InlineImageLoaderOptions
): () => Promise<InlineMailImage | undefined> {
  const read = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let kept: InlineMailImage | undefined;
  let failedAt: number | undefined;
  let pending: Promise<InlineMailImage | undefined> | undefined;
  return async () => {
    if (kept) return kept;
    if (failedAt !== undefined && now() - failedAt < LOGO_RETRY_MS) return undefined;
    pending ??= readImage(options, read)
      .then((image) => {
        if (image) kept = image;
        else failedAt = now();
        return image;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

async function readImage(
  options: InlineImageLoaderOptions,
  read: typeof fetch
): Promise<InlineMailImage | undefined> {
  let url: URL;
  try {
    url = new URL(options.url, options.baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  try {
    const response = await read(url, {
      redirect: "error",
      signal: AbortSignal.timeout(LOGO_READ_TIMEOUT_MS)
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAIL_LOGO_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const content = new Uint8Array(await response.arrayBuffer());
    if (content.byteLength === 0 || content.byteLength > MAIL_LOGO_MAX_BYTES) return undefined;
    const contentType = imageTypeOf(content);
    if (!contentType) return undefined;
    const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
    return {
      contentId: options.contentId,
      contentType,
      filename: `${options.contentId}.${extension}`,
      content
    };
  } catch {
    return undefined;
  }
}

/** The type of an image by its first bytes, never by what a host declares. */
export function imageTypeOf(content: Uint8Array): InlineMailImage["contentType"] | undefined {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => content[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return undefined;
}
