import { ApiError } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../../shared/i18n";
import { apiErrorCode } from "../../shared/workspace-utils";

/**
 * Whether an answer refused the person, as opposed to failing: trying again does not help, and
 * somebody with more rights has to act.
 */
export function isRefusal(error: unknown): boolean {
  const code = apiErrorCode(error);
  return (
    code === "FORBIDDEN" ||
    code === "POLICY_DENIED" ||
    code === "GUARDRAIL_BLOCKED" ||
    (code === undefined && error instanceof ApiError && error.status === 403)
  );
}

/**
 * A refusal on a Settings page, ended by whom to ask: an instance admin by name where the instance
 * has an active one, and never a page the person cannot open.
 */
export function refusalAskingInstanceAdmin(
  refusal: string,
  t: TranslationContextValue["t"],
  instanceAdminName: string | undefined
): string {
  const ask = instanceAdminName
    ? t("settings.askInstanceAdminNamed", { name: instanceAdminName })
    : t("settings.askInstanceAdmin");
  return `${refusal} ${ask}`;
}
