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

export { retryAfterSeconds } from "@work-shape/catalyst-core";
