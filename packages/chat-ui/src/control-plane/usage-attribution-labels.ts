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

type UsageEvent = UsageSummary["recentEvents"][number];

/** Where the amounts of a call that ended with usage come from. */
const SOURCE_LABELS: Record<UsageEvent["source"], TranslationKey> = {
  provider_reported: "settings.usageStatusReported",
  estimated: "settings.usageStatusEstimated",
  not_reported: "settings.usageStatusNothingReported"
};

/**
 * How a call stands, in words: running, failed or abandoned, and for a call that ended with
 * usage where its amounts come from. No value of the record is shown as it is stored.
 */
export function usageStatus(event: UsageEvent, t: TranslationContextValue["t"]): string {
  if (event.status === "pending") return t("settings.usageStatusRunning");
  if (event.status === "failed") return t("settings.usageStatusFailed");
  if (event.status === "abandoned") return t("settings.usageStatusAbandoned");
  return t(SOURCE_LABELS[event.source]);
}
