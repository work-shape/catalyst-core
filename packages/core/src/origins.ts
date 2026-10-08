import { AppError } from "./errors";

export function normalizeAllowedOrigins(value: unknown = []): string[] {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Allowed origins must be a string or an array of strings"
    );
  }
  const origins = Array.from(values, (value: unknown) => {
    if (typeof value !== "string" || value.includes("*")) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Allowed origins must be HTTP or HTTPS URLs without wildcards"
      );
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new AppError("VALIDATION_FAILED", "Allowed origins must be valid HTTP or HTTPS URLs");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin === "null" ||
      url.origin.includes("*")
    ) {
      throw new AppError("VALIDATION_FAILED", "Allowed origins must be HTTP or HTTPS URLs");
    }
    return url.origin;
  });
  return [...new Set(origins)];
}
