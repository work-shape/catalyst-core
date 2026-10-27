import type { SafeConfig } from "@work-shape/catalyst-api-client";
import { isPlatformRunFailureCode, platformToolFailureReason } from "@work-shape/catalyst-core";

// Where the conversation offers "Problem an Workshape melden" (PLATFORM-REPORT), with the same
// classification the server applies again from its own records.

/** Where the instance takes reports: an operator address and platform mail. */
export interface PlatformReportSetup {
  conversationId: string;
  instanceName: string;
}

export function platformReportSetup(
  config: Pick<SafeConfig, "clientInstance" | "platformReport"> | undefined,
  conversationId: string | undefined
): PlatformReportSetup | undefined {
  if (!conversationId || config?.platformReport?.available !== true) return undefined;
  return { conversationId, instanceName: config.clientInstance.displayName };
}

/** What the dialog shows of a failure: the code, and the time where it is known. */
export interface PlatformFailure {
  errorCode: string;
  at?: string;
}

/**
 * The platform failure of a stored tool result's output: an error whose `details.reason` names
 * a platform reason, as `workspace.exec` writes it. A refusal or a failure of what the command
 * ran has none.
 */
export function platformFailureOfToolOutput(output: unknown): PlatformFailure | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const error: unknown = Reflect.get(output, "error");
  const reason = platformToolFailureReason(error);
  if (!reason) return undefined;
  const details: unknown =
    typeof error === "object" && error !== null ? Reflect.get(error, "details") : undefined;
  const at: unknown =
    typeof details === "object" && details !== null ? Reflect.get(details, "at") : undefined;
  return { errorCode: reason, ...(typeof at === "string" ? { at } : {}) };
}

/** The platform failure of a run that ended failed, from its error code. */
export function platformFailureOfRunError(
  error: { class: string; code?: string } | undefined
): PlatformFailure | undefined {
  const code = error?.class === "run_failed" ? error.code : undefined;
  return code !== undefined && isPlatformRunFailureCode(code) ? { errorCode: code } : undefined;
}
