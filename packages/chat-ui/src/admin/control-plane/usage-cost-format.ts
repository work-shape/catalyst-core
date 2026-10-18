import type { UsageSummary } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../../shared/i18n";

export function formatBillableCost(
  cost:
    Pick<UsageSummary["today"]["cost"], "currency" | "billableCostMicros" | "complete"> | undefined,
  i18n: TranslationContextValue
): string {
  if (cost && !cost.complete) {
    return i18n.t("settings.usageIncomplete");
  }
  return formatMicrosCost(cost?.billableCostMicros, cost?.currency, i18n);
}

export function formatWebSearchBillableCost(
  cost:
    | Pick<UsageSummary["today"]["cost"], "currency" | "webSearchBillableCostMicros" | "complete">
    | undefined,
  i18n: TranslationContextValue
): string {
  if (cost && !cost.complete) {
    return i18n.t("settings.usageIncomplete");
  }
  return formatMicrosCost(cost?.webSearchBillableCostMicros, cost?.currency, i18n);
}

export function formatMicrosCost(
  micros: number | undefined,
  currency: string | undefined,
  { t, locale }: TranslationContextValue
): string {
  if (micros === undefined || currency === undefined) {
    return t("settings.usageNotPriced");
  }
  const amount = micros / 1_000_000;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: amount > 0 && amount < 1 ? 4 : 2
  }).format(amount);
}
