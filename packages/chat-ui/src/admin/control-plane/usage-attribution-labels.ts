import type { UsageSummary } from "@work-shape/catalyst-api-client";
import { PERSONAL_AGENTS_KEY } from "@work-shape/catalyst-core";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";

const PURPOSE_LABELS: Record<string, TranslationKey> = {
  conversation_title: "settings.usagePurposeConversationTitle",
  document_extraction: "settings.usagePurposeDocumentExtraction",
  guardrail_judge: "settings.usagePurposeGuardrailJudge",
  knowledge_embedding: "settings.usagePurposeKnowledgeEmbedding",
  knowledge_field_extraction: "settings.usagePurposeKnowledgeFieldExtraction",
  knowledge_query: "settings.usagePurposeKnowledgeQuery"
};

const REGION_LABELS: Record<string, TranslationKey> = {
  eu: "settings.usageRegionEu",
  global: "settings.usageRegionGlobal"
};

/**
 * Who made the call: the agent of a run by the name people know it by, or what the product made
 * the call for. An agent the instance no longer offers keeps its id.
 */
export function usageCaller(
  event: UsageSummary["recentEvents"][number],
  t: TranslationContextValue["t"],
  agentLabel: (agentName: string) => string | undefined
): string {
  const label = event.purpose === undefined ? undefined : PURPOSE_LABELS[event.purpose];
  return label ? t(label) : usageAgentLabel(event.agentName, t, agentLabel);
}

/**
 * An agent as the Usage page names it: by the name people know it by, its id where the instance
 * no longer offers it, and people's own agents in a shared workspace as one row.
 */
export function usageAgentLabel(
  agentName: string,
  t: TranslationContextValue["t"],
  agentLabel: (agentName: string) => string | undefined
): string {
  if (agentName === PERSONAL_AGENTS_KEY) return t("usageReports.personalAgents");
  return agentLabel(agentName) ?? agentName;
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
