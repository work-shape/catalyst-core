import {
  type ModelUsageEventInput,
  type UsageCostComponents,
  type UsageCostMissingMeter,
  type UsageCostRecord,
  type UsageRateCardConfig,
  type UsageRateCardTokenRatesConfig,
  isBilledAsFast
} from "@work-shape/catalyst-core";

/** The fields of a usage event that its cost is settled from. */
export type UsageCostEvent = Pick<
  ModelUsageEventInput,
  | "providerId"
  | "model"
  | "inputTokens"
  | "cachedInputTokens"
  | "cacheWriteInputTokens"
  | "outputTokens"
  | "source"
  | "webSearchCallCount"
  | "fastMode"
  | "providerServiceTier"
> & {
  /**
   * Set on a transcription, which is priced per minute of its audio instead of by tokens:
   * the seconds the provider counted, absent where it counted none.
   */
  audio?: { seconds?: number };
};

export function calculateUsageCost(
  event: UsageCostEvent,
  rateCard: UsageRateCardConfig | undefined,
  source: UsageCostRecord["source"] = "rate_card"
): UsageCostRecord {
  if (event.audio !== undefined) {
    return calculateTranscriptionCost(event, event.audio.seconds, rateCard, source);
  }
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
      ...(tokenRates.cacheWriteInputPricePerMillionTokens === undefined
        ? {}
        : {
            cacheWriteInputPricePerMillionTokens: tokenRates.cacheWriteInputPricePerMillionTokens
          }),
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

/**
 * The cost of a transcription: its audio at the rate card's price per minute (STT-1). The
 * audio is the call's input, so its price stands as the uncached input; tokens cost nothing.
 */
function calculateTranscriptionCost(
  event: UsageCostEvent,
  seconds: number | undefined,
  rateCard: UsageRateCardConfig | undefined,
  source: UsageCostRecord["source"]
): UsageCostRecord {
  const rate = rateCard && findTranscriptionRate(rateCard, event);
  if (!rateCard || !rate) {
    return incompleteCost("unpriced", source, ["transcription_rate"], rateCard);
  }
  const provenance = {
    source,
    calculationVersion: 1 as const,
    rateCardId: rateCard.id,
    rateCardVersion: rateCard.version,
    currency: rateCard.currency,
    appliedRates: {
      uncachedInputPricePerMillionTokens: 0,
      cachedInputPricePerMillionTokens: 0,
      outputPricePerMillionTokens: 0,
      audioPricePerMinute: rate.pricePerAudioMinute
    }
  };
  if (seconds === undefined) {
    return { status: "incomplete", ...provenance, missingMeters: ["audio_duration"] };
  }
  const components: UsageCostComponents = {
    uncachedInputCostMicros: priceAudioSeconds(seconds, rate.pricePerAudioMinute),
    cachedInputCostMicros: 0,
    outputCostMicros: 0,
    webSearchCostMicros: 0
  };
  return {
    status: "settled",
    ...provenance,
    components,
    totalCostMicros: totalComponents(components)
  };
}

/** The rate card's price per audio minute for the model of a call, if it has one. */
export function findTranscriptionRate(
  rateCard: UsageRateCardConfig,
  call: { providerId: string; model: string }
): { pricePerAudioMinute: number } | undefined {
  return (rateCard.transcription ?? []).find(
    (candidate) => candidate.providerId === call.providerId && candidate.model === call.model
  );
}

/** What seconds of audio cost, in micros, at a price per minute. */
export function priceAudioSeconds(seconds: number, pricePerAudioMinute: number): number {
  return Math.round((normalizeCount(seconds) * pricePerAudioMinute * 1_000_000) / 60);
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
  const inputTokens = normalizeCount(event.inputTokens);
  // What was written to a cache is input that was not read from one. A card without a write
  // rate prices it as uncached input.
  const cacheWriteInputTokens = inputKnown
    ? Math.min(
        normalizeCount(event.cacheWriteInputTokens ?? 0),
        Math.max(0, inputTokens - cachedInputTokens)
      )
    : 0;
  const uncachedInputTokens = inputKnown
    ? Math.max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens)
    : 0;
  return {
    uncachedInputCostMicros: inputKnown
      ? priceTokens(uncachedInputTokens, tokenRates.uncachedInputPricePerMillionTokens) +
        priceTokens(
          cacheWriteInputTokens,
          tokenRates.cacheWriteInputPricePerMillionTokens ??
            tokenRates.uncachedInputPricePerMillionTokens
        )
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
