import {
  type ModelUsageEventInput,
  type UsageCostComponents,
  type UsageCostMissingMeter,
  type UsageCostRecord,
  type UsageRateCardConfig,
  type UsageRateCardTokenRatesConfig,
  isBilledAsFast
} from "@vivd-catalyst/core";

/** The fields of a usage event that its cost is settled from. */
export type UsageCostEvent = Pick<
  ModelUsageEventInput,
  | "providerId"
  | "model"
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "source"
  | "webSearchCallCount"
  | "fastMode"
  | "providerServiceTier"
>;

export function calculateUsageCost(
  event: UsageCostEvent,
  rateCard: UsageRateCardConfig | undefined,
  source: UsageCostRecord["source"] = "rate_card"
): UsageCostRecord {
  if (!rateCard) {
    return incompleteCost("unpriced", source, ["model_rate"]);
  }
  if (event.source === "not_reported") {
    return incompleteCost("incomplete", source, ["token_usage"], rateCard);
  }

  const modelRate = rateCard.models.find(
    (candidate) => candidate.providerId === event.providerId && candidate.model === event.model
  );
  if (!modelRate) {
    return incompleteCost("unpriced", source, ["model_rate"], rateCard);
  }
  // A call billed as fast is never settled with the normal rates.
  const tokenRates = isBilledAsFast(event) ? modelRate.fast : modelRate;
  if (!tokenRates) {
    return incompleteCost("unpriced", source, ["fast_model_rate"], rateCard);
  }

  const webSearchRate = findWebSearchRate(rateCard, event);
  const missingMeters: UsageCostMissingMeter[] = [];
  const cachedInputTokens = event.cachedInputTokens;
  const cachePriceDiffers =
    tokenRates.cachedInputPricePerMillionTokens !== tokenRates.uncachedInputPricePerMillionTokens;
  if (cachedInputTokens === undefined && cachePriceDiffers) {
    missingMeters.push("cached_input_tokens");
  }
  if ((event.webSearchCallCount ?? 0) > 0 && !webSearchRate) {
    missingMeters.push("web_search_rate");
  }

  const components = calculateKnownComponents(event, tokenRates, webSearchRate);
  const provenance = {
    source,
    calculationVersion: 1 as const,
    rateCardId: rateCard.id,
    rateCardVersion: rateCard.version,
    currency: rateCard.currency,
    appliedRates: {
      uncachedInputPricePerMillionTokens: tokenRates.uncachedInputPricePerMillionTokens,
      cachedInputPricePerMillionTokens: tokenRates.cachedInputPricePerMillionTokens,
      outputPricePerMillionTokens: tokenRates.outputPricePerMillionTokens,
      ...(webSearchRate ? { webSearchPricePerCall: webSearchRate.pricePerCall } : {})
    }
  };

  if (missingMeters.length > 0) {
    return {
      status: "incomplete",
      ...provenance,
      knownComponents: components,
      knownCostMicros: totalComponents(components),
      missingMeters
    };
  }

  return {
    status: "settled",
    ...provenance,
    components,
    totalCostMicros: totalComponents(components)
  };
}

function calculateKnownComponents(
  event: UsageCostEvent,
  tokenRates: UsageRateCardTokenRatesConfig,
  webSearchRate: { pricePerCall: number } | undefined
): UsageCostComponents {
  const cachedInputTokens =
    event.cachedInputTokens ??
    (tokenRates.cachedInputPricePerMillionTokens === tokenRates.uncachedInputPricePerMillionTokens
      ? 0
      : undefined);
  const inputKnown = cachedInputTokens !== undefined;
  const uncachedInputTokens = inputKnown
    ? Math.max(0, normalizeCount(event.inputTokens) - cachedInputTokens)
    : 0;
  return {
    uncachedInputCostMicros: inputKnown
      ? priceTokens(uncachedInputTokens, tokenRates.uncachedInputPricePerMillionTokens)
      : 0,
    cachedInputCostMicros: inputKnown
      ? priceTokens(cachedInputTokens, tokenRates.cachedInputPricePerMillionTokens)
      : 0,
    outputCostMicros: priceTokens(
      normalizeCount(event.outputTokens),
      tokenRates.outputPricePerMillionTokens
    ),
    webSearchCostMicros: webSearchRate
      ? Math.round((event.webSearchCallCount ?? 0) * webSearchRate.pricePerCall * 1_000_000)
      : 0
  };
}

function incompleteCost(
  status: "incomplete" | "unpriced",
  source: UsageCostRecord["source"],
  missingMeters: UsageCostMissingMeter[],
  rateCard?: UsageRateCardConfig
): UsageCostRecord {
  return {
    status,
    source,
    calculationVersion: 1,
    ...(rateCard
      ? {
          rateCardId: rateCard.id,
          rateCardVersion: rateCard.version,
          currency: rateCard.currency
        }
      : {}),
    missingMeters
  };
}

function findWebSearchRate(
  rateCard: UsageRateCardConfig,
  event: UsageCostEvent
): { pricePerCall: number } | undefined {
  const rates = rateCard.webSearch ?? [];
  return (
    rates.find(
      (candidate) => candidate.providerId === event.providerId && candidate.model === event.model
    ) ??
    rates.find(
      (candidate) => candidate.providerId === event.providerId && candidate.model === undefined
    )
  );
}

export function totalComponents(components: UsageCostComponents): number {
  return (
    components.uncachedInputCostMicros +
    components.cachedInputCostMicros +
    components.outputCostMicros +
    components.webSearchCostMicros
  );
}

export function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function priceTokens(tokens: number, pricePerMillionTokens: number): number {
  return Math.round(normalizeCount(tokens) * pricePerMillionTokens);
}
