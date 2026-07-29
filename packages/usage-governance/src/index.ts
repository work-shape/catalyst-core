import {
  AppError,
  type ClientInstanceId,
  type ModelUsageEvent,
  type ModelUsageEventInput,
  type ModelUsageEventStore,
  type ModelUsageRecorder,
  type ModelUsageWindowSummary,
  type SettledUsageCostRecord,
  type UsageBudgetConfig,
  type UsageCostComponents,
  type UsageCostConfig,
  type UsageCostMissingMeter,
  type UsageCostRecord,
  type UsageRateCardConfig,
  type UsageRateCardModelConfig,
  type UsageSafeguardsConfig,
  createModelUsageWindowBounds
} from "@vivd-catalyst/core";

export interface ModelUsageGovernanceOptions {
  store: ModelUsageEventStore;
  budget: UsageBudgetConfig;
  safeguards: UsageSafeguardsConfig;
  costs?: UsageCostConfig;
}

export interface SafeModelUsageBillableCost {
  status: UsageCostRecord["status"];
  currency?: string;
  uncachedInputBillableCostMicros?: number;
  cachedInputBillableCostMicros?: number;
  outputBillableCostMicros?: number;
  webSearchBillableCostMicros?: number;
  billableCostMicros?: number;
  complete: boolean;
  webSearchCostVisible: boolean;
}

export interface SafeModelUsageBillableCostSummary extends SafeModelUsageBillableCost {
  settledModelCallCount: number;
  incompleteModelCallCount: number;
  settledWebSearchCallCount: number;
  incompleteWebSearchCallCount: number;
}

export interface SafeCostedModelUsageWindowSummary extends ModelUsageWindowSummary {
  cost: SafeModelUsageBillableCostSummary;
}

export interface SafeCostedModelUsageDailyBucket extends SafeCostedModelUsageWindowSummary {
  date: string;
}

export interface SafeCostedModelUsageMonthlyBucket extends SafeCostedModelUsageWindowSummary {
  month: string;
}

export type SafeModelUsageEvent = Pick<
  ModelUsageEvent,
  | "id"
  | "clientInstanceId"
  | "conversationId"
  | "agentRunId"
  | "agentName"
  | "providerId"
  | "model"
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "totalTokens"
  | "source"
  | "webSearchCallCount"
  | "correlationId"
  | "createdAt"
>;

export interface SafeCostedModelUsageEvent extends SafeModelUsageEvent {
  cost: SafeModelUsageBillableCost;
}

export interface SafeUsageSpendBudget {
  currency?: string;
  dailyLimitMicros?: number;
  monthlyLimitMicros?: number;
}

export interface UsageSummary {
  generatedAt: string;
  budget: UsageBudgetConfig;
  safeguards: UsageSafeguardsConfig;
  costs: UsageCostConfig;
  today: ModelUsageWindowSummary;
  currentMonth: ModelUsageWindowSummary;
  allTime: ModelUsageWindowSummary;
  recentEvents: ModelUsageEvent[];
}

export interface SafeUsageSummary {
  generatedAt: string;
  spendBudget: SafeUsageSpendBudget;
  safeguards: UsageSafeguardsConfig;
  today: SafeCostedModelUsageWindowSummary;
  currentMonth: SafeCostedModelUsageWindowSummary;
  allTime: SafeCostedModelUsageWindowSummary;
  dailyUsage: SafeCostedModelUsageDailyBucket[];
  monthlyUsage: SafeCostedModelUsageMonthlyBucket[];
  recentEvents: SafeCostedModelUsageEvent[];
}

export class ModelUsageGovernance implements ModelUsageRecorder {
  private readonly store: ModelUsageEventStore;
  private readonly budget: UsageBudgetConfig;
  private readonly safeguards: UsageSafeguardsConfig;
  private readonly costs: UsageCostConfig;
  private readonly clientLocks = new Map<string, Promise<void>>();
  private readonly inFlightModelCalls = new Map<string, number>();

  constructor(options: ModelUsageGovernanceOptions) {
    this.store = options.store;
    this.budget = options.budget;
    this.safeguards = options.safeguards;
    this.costs = options.costs ?? {};
  }

  async runModelCall<T>(
    clientInstanceId: ClientInstanceId,
    execute: () => Promise<T>
  ): Promise<T> {
    const reservation = await this.reserveModelCall(clientInstanceId);
    try {
      return execute();
    } finally {
      await this.settleModelCall(reservation);
    }
  }

  recordModelUsage(input: ModelUsageEventInput): Promise<ModelUsageEvent> {
    const normalizedInput: ModelUsageEventInput = {
      ...input,
      inputTokens: normalizeCount(input.inputTokens),
      ...(input.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: normalizeCachedInputTokens(input.cachedInputTokens, input.inputTokens) }),
      outputTokens: normalizeCount(input.outputTokens),
      totalTokens: normalizeCount(input.totalTokens),
      webSearchCallCount: normalizeCount(input.webSearchCallCount ?? 0)
    };
    return this.store.appendModelUsageEvent({
      ...normalizedInput,
      webSearchCallCount: normalizedInput.webSearchCallCount ?? 0,
      customerBillableCost: calculateUsageCost(normalizedInput, this.costs.customer)
    });
  }

  summarizeModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
  }): Promise<ModelUsageWindowSummary> {
    return this.store.summarizeModelUsageEvents(input);
  }

  listModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<ModelUsageEvent[]> {
    return this.store.listModelUsageEvents(input);
  }

  async createSummary(input: {
    clientInstanceId: ClientInstanceId;
    now?: Date;
  }): Promise<UsageSummary> {
    const now = input.now ?? new Date();
    const { todayStart, currentMonthStart } = createModelUsageWindowBounds(now);
    const allEvents = await this.store.listModelUsageEvents({
      clientInstanceId: input.clientInstanceId
    });
    return {
      generatedAt: now.toISOString(),
      budget: this.budget,
      safeguards: this.safeguards,
      costs: this.costs,
      today: summarizeEvents(filterEventsByWindow(allEvents, todayStart), todayStart),
      currentMonth: summarizeEvents(
        filterEventsByWindow(allEvents, currentMonthStart),
        currentMonthStart
      ),
      allTime: summarizeEvents(allEvents),
      recentEvents: allEvents.slice(0, 25)
    };
  }

  async createSafeSummary(input: {
    clientInstanceId: ClientInstanceId;
    now?: Date;
    webSearchEnabled?: boolean;
  }): Promise<SafeUsageSummary> {
    const now = input.now ?? new Date();
    const { todayStart, currentMonthStart } = createModelUsageWindowBounds(now);
    const allEvents = await this.store.listModelUsageEvents({
      clientInstanceId: input.clientInstanceId
    });
    const todayEvents = filterEventsByWindow(allEvents, todayStart);
    const currentMonthEvents = filterEventsByWindow(allEvents, currentMonthStart);
    const showWebSearchCost =
      input.webSearchEnabled ??
      Boolean(
        this.costs.customer?.webSearch?.length ||
          allEvents.some((event) => event.webSearchCallCount > 0)
      );

    return {
      generatedAt: now.toISOString(),
      spendBudget: {
        ...(this.costs.customer?.currency
          ? { currency: this.costs.customer.currency }
          : {}),
        ...(this.budget.dailySpendLimit === undefined
          ? {}
          : { dailyLimitMicros: toMicros(this.budget.dailySpendLimit) }),
        ...(this.budget.monthlySpendLimit === undefined
          ? {}
          : { monthlyLimitMicros: toMicros(this.budget.monthlySpendLimit) })
      },
      safeguards: this.safeguards,
      today: summarizeSafeEvents(
        todayEvents,
        todayStart,
        undefined,
        this.costs.customer,
        showWebSearchCost
      ),
      currentMonth: summarizeSafeEvents(
        currentMonthEvents,
        currentMonthStart,
        undefined,
        this.costs.customer,
        showWebSearchCost
      ),
      allTime: summarizeSafeEvents(
        allEvents,
        undefined,
        undefined,
        this.costs.customer,
        showWebSearchCost
      ),
      dailyUsage: summarizeSafeDailyBuckets(
        allEvents,
        now,
        this.costs.customer,
        showWebSearchCost
      ),
      monthlyUsage: summarizeSafeMonthlyBuckets(
        allEvents,
        now,
        this.costs.customer,
        showWebSearchCost
      ),
      recentEvents: allEvents.slice(0, 25).map((event) => toSafeEvent(event, showWebSearchCost))
    };
  }

  private async assertAllowed(clientInstanceId: ClientInstanceId): Promise<void> {
    if (
      !this.safeguards.modelCallsPerDay &&
      !this.safeguards.tokensPerDay &&
      !this.safeguards.tokensPerMonth &&
      !this.budget.dailySpendLimit &&
      !this.budget.monthlySpendLimit
    ) {
      return;
    }

    const { todayStart, currentMonthStart } = createModelUsageWindowBounds();
    const today = await this.store.summarizeModelUsageEvents({
      clientInstanceId,
      start: todayStart
    });
    assertDailySafeguards(today, this.safeguards, this.countInFlightModelCalls(clientInstanceId));

    if (this.budget.dailySpendLimit) {
      const todayEvents = await this.store.listModelUsageEvents({
        clientInstanceId,
        start: todayStart
      });
      assertSpendBudget(todayEvents, this.budget.dailySpendLimit, "Daily");
    }

    if (this.safeguards.tokensPerMonth || this.budget.monthlySpendLimit) {
      const currentMonth = await this.store.summarizeModelUsageEvents({
        clientInstanceId,
        start: currentMonthStart
      });
      if (
        this.safeguards.tokensPerMonth &&
        currentMonth.totalTokens >= this.safeguards.tokensPerMonth
      ) {
        throw new AppError("FORBIDDEN", "Monthly model token safeguard has been reached");
      }

      if (this.budget.monthlySpendLimit) {
        const currentMonthEvents = await this.store.listModelUsageEvents({
          clientInstanceId,
          start: currentMonthStart
        });
        assertSpendBudget(currentMonthEvents, this.budget.monthlySpendLimit, "Monthly");
      }
    }
  }

  private async reserveModelCall(clientInstanceId: ClientInstanceId): Promise<{
    clientInstanceId: ClientInstanceId;
  }> {
    return this.withClientLock(clientInstanceId, async () => {
      await this.assertAllowed(clientInstanceId);
      this.inFlightModelCalls.set(
        clientInstanceId,
        this.countInFlightModelCalls(clientInstanceId) + 1
      );
      return { clientInstanceId };
    });
  }

  private async settleModelCall(reservation: { clientInstanceId: ClientInstanceId }): Promise<void> {
    await this.withClientLock(reservation.clientInstanceId, async () => {
      const nextCount = Math.max(0, this.countInFlightModelCalls(reservation.clientInstanceId) - 1);
      if (nextCount === 0) {
        this.inFlightModelCalls.delete(reservation.clientInstanceId);
        return;
      }
      this.inFlightModelCalls.set(reservation.clientInstanceId, nextCount);
    });
  }

  private countInFlightModelCalls(clientInstanceId: ClientInstanceId): number {
    return this.inFlightModelCalls.get(clientInstanceId) ?? 0;
  }

  private withClientLock<T>(
    clientInstanceId: ClientInstanceId,
    execute: () => Promise<T>
  ): Promise<T> {
    const previous = this.clientLocks.get(clientInstanceId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.clientLocks.set(clientInstanceId, current);
    return previous
      .then(execute)
      .finally(() => {
        release?.();
        if (this.clientLocks.get(clientInstanceId) === current) {
          this.clientLocks.delete(clientInstanceId);
        }
      });
  }
}

export function calculateUsageCost(
  event: ModelUsageEventInput,
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

  const webSearchRate = findWebSearchRate(rateCard, event);
  const missingMeters: UsageCostMissingMeter[] = [];
  const cachedInputTokens = event.cachedInputTokens;
  const cachePriceDiffers =
    modelRate.cachedInputPricePerMillionTokens !==
    modelRate.uncachedInputPricePerMillionTokens;
  if (cachedInputTokens === undefined && cachePriceDiffers) {
    missingMeters.push("cached_input_tokens");
  }
  if ((event.webSearchCallCount ?? 0) > 0 && !webSearchRate) {
    missingMeters.push("web_search_rate");
  }

  const components = calculateKnownComponents(event, modelRate, webSearchRate);
  const provenance = {
    source,
    calculationVersion: 1 as const,
    rateCardId: rateCard.id,
    rateCardVersion: rateCard.version,
    currency: rateCard.currency,
    appliedRates: {
      uncachedInputPricePerMillionTokens: modelRate.uncachedInputPricePerMillionTokens,
      cachedInputPricePerMillionTokens: modelRate.cachedInputPricePerMillionTokens,
      outputPricePerMillionTokens: modelRate.outputPricePerMillionTokens,
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
  event: ModelUsageEventInput,
  modelRate: UsageRateCardModelConfig,
  webSearchRate: { pricePerCall: number } | undefined
): UsageCostComponents {
  const cachedInputTokens =
    event.cachedInputTokens ??
    (modelRate.cachedInputPricePerMillionTokens ===
    modelRate.uncachedInputPricePerMillionTokens
      ? 0
      : undefined);
  const inputKnown = cachedInputTokens !== undefined;
  const uncachedInputTokens = inputKnown
    ? Math.max(0, normalizeCount(event.inputTokens) - cachedInputTokens)
    : 0;
  return {
    uncachedInputCostMicros: inputKnown
      ? priceTokens(uncachedInputTokens, modelRate.uncachedInputPricePerMillionTokens)
      : 0,
    cachedInputCostMicros: inputKnown
      ? priceTokens(cachedInputTokens, modelRate.cachedInputPricePerMillionTokens)
      : 0,
    outputCostMicros: priceTokens(
      normalizeCount(event.outputTokens),
      modelRate.outputPricePerMillionTokens
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
  event: ModelUsageEventInput
): { pricePerCall: number } | undefined {
  const rates = rateCard.webSearch ?? [];
  return (
    rates.find(
      (candidate) =>
        candidate.providerId === event.providerId && candidate.model === event.model
    ) ??
    rates.find(
      (candidate) =>
        candidate.providerId === event.providerId && candidate.model === undefined
    )
  );
}

function summarizeEvents(
  events: ModelUsageEvent[],
  start?: string,
  end?: string
): ModelUsageWindowSummary {
  return events.reduce<ModelUsageWindowSummary>(
    (summary, event) => ({
      ...summary,
      modelCallCount: summary.modelCallCount + 1,
      inputTokens: summary.inputTokens + event.inputTokens,
      cachedInputTokens: summary.cachedInputTokens + (event.cachedInputTokens ?? 0),
      outputTokens: summary.outputTokens + event.outputTokens,
      totalTokens: summary.totalTokens + event.totalTokens,
      webSearchCallCount: summary.webSearchCallCount + event.webSearchCallCount
    }),
    {
      start,
      end,
      modelCallCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      webSearchCallCount: 0
    }
  );
}

function summarizeSafeEvents(
  events: ModelUsageEvent[],
  start: string | undefined,
  end: string | undefined,
  customerRateCard: UsageRateCardConfig | undefined,
  showWebSearchCost: boolean
): SafeCostedModelUsageWindowSummary {
  const usage = summarizeEvents(events, start, end);
  const settled = events.filter(
    (
      event
    ): event is ModelUsageEvent & {
      customerBillableCost: SettledUsageCostRecord;
    } => event.customerBillableCost.status === "settled"
  );
  const incomplete = events.length - settled.length;
  const currencies = new Set(
    settled.map((event) => event.customerBillableCost.currency)
  );
  const complete =
    incomplete === 0 &&
    currencies.size <= 1 &&
    (events.length > 0 || customerRateCard !== undefined);
  const components = settled.reduce<UsageCostComponents>(
    (total, event) => addComponents(total, event.customerBillableCost.components),
    emptyComponents()
  );
  const currency =
    currencies.values().next().value ??
    (events.length === 0 ? customerRateCard?.currency : undefined);
  const modelBillableCostMicros =
    components.uncachedInputCostMicros +
    components.cachedInputCostMicros +
    components.outputCostMicros;
  return {
    ...usage,
    cost: {
      status:
        complete
          ? "settled"
          : events.length === 0 && customerRateCard === undefined
            ? "unpriced"
            : "incomplete",
      ...(currency ? { currency } : {}),
      ...(complete
        ? {
            uncachedInputBillableCostMicros: components.uncachedInputCostMicros,
            cachedInputBillableCostMicros: components.cachedInputCostMicros,
            outputBillableCostMicros: components.outputCostMicros,
            ...(showWebSearchCost
              ? { webSearchBillableCostMicros: components.webSearchCostMicros }
              : {}),
            billableCostMicros: modelBillableCostMicros + components.webSearchCostMicros
          }
        : {}),
      complete,
      webSearchCostVisible: showWebSearchCost,
      settledModelCallCount: settled.length,
      incompleteModelCallCount: incomplete,
      settledWebSearchCallCount: settled.reduce(
        (count, event) => count + event.webSearchCallCount,
        0
      ),
      incompleteWebSearchCallCount: events
        .filter((event) => event.customerBillableCost.status !== "settled")
        .reduce((count, event) => count + event.webSearchCallCount, 0)
    }
  };
}

function toSafeEvent(
  event: ModelUsageEvent,
  showWebSearchCost: boolean
): SafeCostedModelUsageEvent {
  const cost = event.customerBillableCost;
  const settled = cost.status === "settled";
  return {
    id: event.id,
    clientInstanceId: event.clientInstanceId,
    conversationId: event.conversationId,
    agentRunId: event.agentRunId,
    agentName: event.agentName,
    providerId: event.providerId,
    model: event.model,
    inputTokens: event.inputTokens,
    ...(event.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: event.cachedInputTokens }),
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
    source: event.source,
    webSearchCallCount: event.webSearchCallCount,
    correlationId: event.correlationId,
    createdAt: event.createdAt,
    cost: {
      status: cost.status,
      ...(cost.currency ? { currency: cost.currency } : {}),
      ...(settled
        ? {
            uncachedInputBillableCostMicros: cost.components.uncachedInputCostMicros,
            cachedInputBillableCostMicros: cost.components.cachedInputCostMicros,
            outputBillableCostMicros: cost.components.outputCostMicros,
            ...(showWebSearchCost
              ? { webSearchBillableCostMicros: cost.components.webSearchCostMicros }
              : {}),
            billableCostMicros: cost.totalCostMicros
          }
        : {}),
      complete: settled,
      webSearchCostVisible: showWebSearchCost
    }
  };
}

const DAILY_USAGE_BUCKET_COUNT = 30;

function summarizeSafeDailyBuckets(
  events: ModelUsageEvent[],
  now: Date,
  customerRateCard: UsageRateCardConfig | undefined,
  showWebSearchCost: boolean
): SafeCostedModelUsageDailyBucket[] {
  const buckets: SafeCostedModelUsageDailyBucket[] = [];
  for (let offset = DAILY_USAGE_BUCKET_COUNT - 1; offset >= 0; offset -= 1) {
    const start = utcDayStart(now, -offset).toISOString();
    const end = utcDayStart(now, -offset + 1).toISOString();
    buckets.push({
      date: start.slice(0, 10),
      ...summarizeSafeEvents(
        filterEventsByWindow(events, start, end),
        start,
        end,
        customerRateCard,
        showWebSearchCost
      )
    });
  }
  return buckets;
}

function summarizeSafeMonthlyBuckets(
  events: ModelUsageEvent[],
  now: Date,
  customerRateCard: UsageRateCardConfig | undefined,
  showWebSearchCost: boolean
): SafeCostedModelUsageMonthlyBucket[] {
  const earliestCreatedAt = events.reduce<string | undefined>(
    (earliest, event) => (!earliest || event.createdAt < earliest ? event.createdAt : earliest),
    undefined
  );
  const firstMonthStart = earliestCreatedAt
    ? utcMonthStart(new Date(earliestCreatedAt), 0)
    : utcMonthStart(now, 0);
  const buckets: SafeCostedModelUsageMonthlyBucket[] = [];
  for (let offset = 0; ; offset += 1) {
    const startDate = utcMonthStart(firstMonthStart, offset);
    if (startDate > now) {
      break;
    }
    const start = startDate.toISOString();
    const end = utcMonthStart(firstMonthStart, offset + 1).toISOString();
    buckets.push({
      month: start.slice(0, 7),
      ...summarizeSafeEvents(
        filterEventsByWindow(events, start, end),
        start,
        end,
        customerRateCard,
        showWebSearchCost
      )
    });
  }
  return buckets;
}

function assertDailySafeguards(
  summary: ModelUsageWindowSummary,
  safeguards: UsageSafeguardsConfig,
  inFlightCalls: number
): void {
  if (
    safeguards.modelCallsPerDay &&
    summary.modelCallCount + inFlightCalls >= safeguards.modelCallsPerDay
  ) {
    throw new AppError("FORBIDDEN", "Daily model call safeguard has been reached");
  }
  if (safeguards.tokensPerDay && summary.totalTokens >= safeguards.tokensPerDay) {
    throw new AppError("FORBIDDEN", "Daily model token safeguard has been reached");
  }
}

function assertSpendBudget(
  events: ModelUsageEvent[],
  limit: number,
  label: "Daily" | "Monthly"
): void {
  const incomplete = events.find((event) => event.customerBillableCost.status !== "settled");
  if (incomplete) {
    throw new AppError(
      "FORBIDDEN",
      `${label} customer billable cost is incomplete; spend budget cannot be evaluated safely`
    );
  }
  const total = events.reduce(
    (sum, event) =>
      sum +
      (event.customerBillableCost.status === "settled"
        ? event.customerBillableCost.totalCostMicros
        : 0),
    0
  );
  if (total >= toMicros(limit)) {
    throw new AppError("FORBIDDEN", `${label} model spend budget has been reached`);
  }
}

function filterEventsByWindow(
  events: ModelUsageEvent[],
  start?: string,
  end?: string
): ModelUsageEvent[] {
  return events.filter(
    (event) => (!start || event.createdAt >= start) && (!end || event.createdAt < end)
  );
}

function addComponents(
  left: UsageCostComponents,
  right: UsageCostComponents
): UsageCostComponents {
  return {
    uncachedInputCostMicros:
      left.uncachedInputCostMicros + right.uncachedInputCostMicros,
    cachedInputCostMicros: left.cachedInputCostMicros + right.cachedInputCostMicros,
    outputCostMicros: left.outputCostMicros + right.outputCostMicros,
    webSearchCostMicros: left.webSearchCostMicros + right.webSearchCostMicros
  };
}

function emptyComponents(): UsageCostComponents {
  return {
    uncachedInputCostMicros: 0,
    cachedInputCostMicros: 0,
    outputCostMicros: 0,
    webSearchCostMicros: 0
  };
}

function totalComponents(components: UsageCostComponents): number {
  return (
    components.uncachedInputCostMicros +
    components.cachedInputCostMicros +
    components.outputCostMicros +
    components.webSearchCostMicros
  );
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeCachedInputTokens(cached: number, input: number): number {
  return Math.min(normalizeCount(cached), normalizeCount(input));
}

function priceTokens(tokens: number, pricePerMillionTokens: number): number {
  return Math.round(normalizeCount(tokens) * pricePerMillionTokens);
}

function toMicros(value: number): number {
  return Math.round(value * 1_000_000);
}

function utcDayStart(reference: Date, dayOffset: number): Date {
  return new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate() + dayOffset
    )
  );
}

function utcMonthStart(reference: Date, monthOffset: number): Date {
  return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + monthOffset, 1));
}
