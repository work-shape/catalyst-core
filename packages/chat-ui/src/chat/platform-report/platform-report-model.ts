import type { SafeConfig } from "@work-shape/catalyst-api-client";
import { isPlatformRunFailureCode, platformToolFailure } from "@work-shape/catalyst-core";

// Where the conversation offers "Problem an Workshape melden" (PLATFORM-REPORT), with the same
// classification the server applies again from its own records.

/** Where the instance takes reports: an operator address and platform mail. */
export interface PlatformReportSetup {
  conversationId: string;
  instanceName: string;
}

export function platformReportSetup(
  config: Pick<SafeConfig, "clientInstance" | "platformReport"> | undefined,
  conversationId: string | undefined,
  /** An embedding host's session: the report is the person's own, and the server refuses it. */
  embedded = false
): PlatformReportSetup | undefined {
  if (embedded || !conversationId || config?.platformReport?.available !== true) return undefined;
  return { conversationId, instanceName: config.clientInstance.displayName };
}

/** What the dialog shows of a failure: the code, and the time where it is known. */
export interface PlatformFailure {
  errorCode: string;
  at?: string;
}

/** The platform failure of a stored tool result: see `platformToolFailure`. */
export function platformFailureOfToolResult(
  toolName: string,
  output: unknown
): PlatformFailure | undefined {
  const error: unknown =
    typeof output === "object" && output !== null ? Reflect.get(output, "error") : undefined;
  const failure = platformToolFailure(toolName, error);
  return failure
    ? { errorCode: failure.reason, ...(failure.at ? { at: failure.at } : {}) }
    : undefined;
}

/** The platform failure of a run that ended failed, from its error code. */
export function platformFailureOfRunError(
  error: { class: string; code?: string } | undefined
): PlatformFailure | undefined {
  const code = error?.class === "run_failed" ? error.code : undefined;
  return code !== undefined && isPlatformRunFailureCode(code) ? { errorCode: code } : undefined;
}
