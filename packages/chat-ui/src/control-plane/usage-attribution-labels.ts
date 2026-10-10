import type { UsageSummary } from "@vivd-catalyst/api-client";
import type { TranslationContextValue, TranslationKey } from "../i18n";

const PURPOSE_LABELS: Record<string, TranslationKey> = {
  conversation_title: "settings.usagePurposeConversationTitle",
  document_extraction: "settings.usagePurposeDocumentExtraction",
  guardrail_judge: "settings.usagePurposeGuardrailJudge"
};

const REGION_LABELS: Record<string, TranslationKey> = {
  eu: "settings.usageRegionEu",
  global: "settings.usageRegionGlobal"
};

/** Who made the call: the agent of a run, or what the product made the call for. */
export function usageCaller(
  event: UsageSummary["recentEvents"][number],
  t: TranslationContextValue["t"]
): string {
  const label = event.purpose === undefined ? undefined : PURPOSE_LABELS[event.purpose];
  return label ? t(label) : event.agentName;
}

/** A region this version has no name for is shown as it was recorded. */
export function usageRegion(region: string | undefined, t: TranslationContextValue["t"]): string {
  if (region === undefined) return t("settings.usageRegionNotStated");
  const label = REGION_LABELS[region];
  return label ? t(label) : region;
}

/**
 * Where the amounts of a call come from. A call that has not ended has none yet, and a call
 * that ended without an answer has none its provider reported: both are said in words.
 */
export function usageSource(
  event: UsageSummary["recentEvents"][number],
  t: TranslationContextValue["t"]
): string {
  if (event.status === "pending") return t("settings.usageStatusRunning");
  if (event.source === "not_reported") return t("settings.usageStatusNothingReported");
  return event.source;
}
