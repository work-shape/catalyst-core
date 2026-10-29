import type { ModelUsageRefusal } from "@work-shape/catalyst-core";
import type { TranslationKey } from "../i18n";

type Translate = (key: TranslationKey, values?: Record<string, string>) => string;

// The words for each part of the usage limit that refused a call. Its windows are UTC days and
// months. One table serves the notice above the composer, the sentence a Page is told for an
// action and the sentence of a Workflow run that stopped at a limit, so they never differ.

const PERIODS: Record<ModelUsageRefusal["period"], TranslationKey> = {
  day: "runUsageLimitPeriodDay",
  month: "runUsageLimitPeriodMonth"
};
const RESETS: Record<ModelUsageRefusal["period"], TranslationKey> = {
  day: "runUsageLimitResetDay",
  month: "runUsageLimitResetMonth"
};
const METRICS: Record<ModelUsageRefusal["metric"], TranslationKey> = {
  modelCallCount: "runUsageLimitMetricModelCallCount",
  tokens: "runUsageLimitMetricTokens",
  costMicros: "runUsageLimitMetricCostMicros"
};
const SCOPES: Record<ModelUsageRefusal["scope"], TranslationKey> = {
  user: "runUsageLimitScopeUser",
  system: "runUsageLimitScopeSystem",
  instance: "runUsageLimitScopeInstance",
  workspace: "runUsageLimitScopeWorkspace"
};

/** The limit named in the reader's language: its window, what it counts, whose calls, the reset. */
export function usageLimitWords(
  limit: ModelUsageRefusal,
  t: Translate
): { period: string; metric: string; scope: string; reset: string } {
  return {
    period: t(PERIODS[limit.period]),
    metric: t(METRICS[limit.metric]),
    scope: t(SCOPES[limit.scope]),
    reset: t(RESETS[limit.period])
  };
}

/**
 * The sentence for a call a usage limit refused where no reply is cut short: which limit it
 * was, when it resets and who can raise it. Without the limit, only that one was reached.
 */
export function usageLimitSentence(limit: ModelUsageRefusal | undefined, t: Translate): string {
  return limit
    ? t("refusals.usageLimitNamed", usageLimitWords(limit, t))
    : t("refusals.usageLimitReached");
}
