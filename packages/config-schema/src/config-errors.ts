import { AppError } from "@vivd-catalyst/core";

/**
 * The message carries the first issue, so a log line or a terminal names the key that stopped
 * startup. Issue messages come from the schemas and quote no config value.
 */
export function invalidConfigError(
  summary: string,
  issues: readonly { path: PropertyKey[]; message: string }[]
): AppError {
  const first = issues[0];
  const detail = first ? `: ${first.path.map(String).join(".")}: ${first.message}` : "";
  return new AppError("VALIDATION_FAILED", `${summary}${detail}`, { issues });
}
