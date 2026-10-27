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

/** The tool whose failures name a platform reason. */
export const PLATFORM_FAILURE_TOOL = "workspace.exec";

/** A tool's failure that was the platform's, with what of it a report may carry. */
export interface PlatformToolFailure {
  reason: PlatformToolFailureReason;
  /** The workspace command, where its id has the platform's own form. */
  commandId?: string;
  /** When it failed, where the result says so as a time. */
  at?: string;
}

const COMMAND_ID = /^wcmd_[A-Za-z0-9_-]{1,80}$/u;

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * The platform failure of a failed tool's error: only `workspace.exec` names one, in
 * `details.reason`. Anything else, a refusal, a failure of what the command ran or another
 * tool's error that repeats such a word, has none. The command id and the time are taken only
 * in the form the platform writes them, since a report carries them out of the instance.
 */
export function platformToolFailure(
  toolName: string,
  error: unknown
): PlatformToolFailure | undefined {
  if (toolName !== PLATFORM_FAILURE_TOOL) return undefined;
  const details = field(error, "details");
  const reason = PLATFORM_TOOL_FAILURE_REASONS.find((known) => known === field(details, "reason"));
  if (!reason) return undefined;
  const commandId = field(details, "commandId");
  const at = field(details, "at");
  const time = typeof at === "string" && at.length <= 40 ? new Date(at) : undefined;
  return {
    reason,
    ...(typeof commandId === "string" && COMMAND_ID.test(commandId) ? { commandId } : {}),
    ...(time && !Number.isNaN(time.getTime()) ? { at: time.toISOString() } : {})
  };
}
