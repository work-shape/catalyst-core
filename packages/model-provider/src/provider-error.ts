export function readProviderErrorMetadata(
  payload: unknown,
  headers?: Headers
): { providerErrorType?: string; providerErrorCode?: string | number; requestId?: string } {
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
    requestId: identifier(headers?.get("x-request-id") ?? headers?.get("request-id"))
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
