import { AGENT_RUN_COMMAND_NOT_TAKEN_CODE } from "./agent-run-jobs";

// PLATFORM-REPORT: which failures are the platform's, not the command's or the person's. The
// conversation offers a report for them, and the server accepts one only for them.

/**
 * The reasons a `workspace.exec` result names in `details.reason` when the platform could not
 * run the command: its sandbox did not start, no worker took it, or the worker or the runner
 * failed. None of it is the command's doing, nor the person's to fix.
 */
export const PLATFORM_TOOL_FAILURE_REASONS = [
  "sandbox_unavailable",
  "no_worker",
  "platform_error"
] as const;
export type PlatformToolFailureReason = (typeof PLATFORM_TOOL_FAILURE_REASONS)[number];

/** The codes of a run that failed for the platform: it waited for a command no worker took. */
export const PLATFORM_RUN_FAILURE_CODES: readonly string[] = [AGENT_RUN_COMMAND_NOT_TAKEN_CODE];

export function isPlatformRunFailureCode(code: string | undefined): boolean {
  return code !== undefined && PLATFORM_RUN_FAILURE_CODES.includes(code);
}

/**
 * The platform reason of a failed tool's error, read from `details.reason` as `workspace.exec`
 * writes it. Anything else, a refusal or a failure of what the command ran, has none.
 */
export function platformToolFailureReason(error: unknown): PlatformToolFailureReason | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return PLATFORM_TOOL_FAILURE_REASONS.find((known) => known === reason);
}
