import { isRecord } from "@work-shape/catalyst-core";
import { boundProviderMessage } from "./model-provider-error";

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

/**
 * What the provider wrote about its refusal, cut to the log limit. It can repeat what a user
 * sent, so it goes into `ModelProviderError.providerMessage` and nowhere else.
 */
export function readProviderErrorMessage(payload: unknown): string | undefined {
  const error = isRecord(payload) ? (isRecord(payload.error) ? payload.error : payload) : {};
  return boundProviderMessage(error.message);
}

/**
 * Whether a provider refused the request for an `encrypted_content` string in it: above the
 * provider's string limit, or one it cannot decrypt, such as one another deployment produced.
 * Read from the error's code and parameter, not from its message.
 */
export function isEncryptedContentRejected(payload: unknown): boolean {
  const error = isRecord(payload) ? (isRecord(payload.error) ? payload.error : payload) : {};
  if (error.code === "invalid_encrypted_content") return true;
  return (
    error.code === "string_above_max_length" &&
    typeof error.param === "string" &&
    /(?:^|\.)encrypted_content$/u.test(error.param)
  );
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
