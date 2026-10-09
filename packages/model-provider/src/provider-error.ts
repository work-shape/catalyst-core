export function readProviderErrorMetadata(
  payload: unknown,
  headers?: Headers
): {
  providerErrorType?: string;
  providerErrorCode?: string | number;
  requestId?: string;
  retryAfterMs?: number;
} {
  const error = isRecord(payload) ? (isRecord(payload.error) ? payload.error : payload) : {};
  // Only bounded identifiers from known fields cross the provider boundary.
  const identifier = (value: unknown): string | undefined =>
    typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value) ? value : undefined;
  return {
    providerErrorType: identifier(error.type),
    providerErrorCode:
      typeof error.code === "number" && Number.isSafeInteger(error.code)
        ? error.code
        : identifier(error.code),
    requestId: identifier(headers?.get("x-request-id") ?? headers?.get("request-id")),
    ...retryAfter(headers?.get("retry-after"))
  };
}

/** `Retry-After` is a number of seconds or an HTTP date; a date in the past means no wait. */
function retryAfter(value: string | null | undefined): { retryAfterMs?: number } {
  const text = value?.trim();
  if (!text) {
    return {};
  }
  const retryAfterMs = /^\d{1,9}$/u.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - Date.now();
  return Number.isFinite(retryAfterMs) ? { retryAfterMs: Math.max(0, retryAfterMs) } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
