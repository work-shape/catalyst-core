import { isAppError } from "@work-shape/catalyst-core";

/** Keep only a finite wait, never the source's header or any other error details. */
export function retryAfterSecondsOf(error: unknown): number | undefined {
  if (!isAppError(error)) return undefined;
  const details = error.details;
  if (typeof details !== "object" || details === null || !("retryAfterSeconds" in details))
    return undefined;
  const value = details.retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Bounds untrusted header parsing; longer advice is discarded. */
const RETRY_AFTER_HEADER_MAX_CHARS = 128;

/** Retry-After is seconds or an HTTP date. An invalid header gives no advice. */
export function retryAfterSeconds(header: string | string[] | undefined): number | undefined {
  if (typeof header !== "string" || header.length > RETRY_AFTER_HEADER_MAX_CHARS) return undefined;
  const text = header.trim();
  const seconds = /^\d{1,9}$/u.test(text)
    ? Number(text)
    : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(text)
      ? (Date.parse(text) - Date.now()) / 1000
      : NaN;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
}
