import {
  AppError,
  type ClientInstanceId,
  type ModelUsageEvent,
  type ModelUsageEventInput,
  type ModelUsageEventStore,
  type ModelUsageWindowSummary,
  type UsageBudgetConfig,
  type UsagePricingConfig,
  type UsageSafeguardsConfig,
  createModelUsageWindowBounds
} from "@vivd-catalyst/core";

export interface ModelUsageGovernanceOptions {
  store: ModelUsageEventStore;
  budget: UsageBudgetConfig;
  safeguards: UsageSafeguardsConfig;
  pricing?: UsagePricingConfig;
}

export interface ModelUsageCost {
  currency: string;
  inputCostMicros: number;
  outputCostMicros: number;
  webSearchCostMicros: number;
  totalCostMicros: number;
  budgetedCostMicros: number;
  costSafetyMultiplier: number;
  pricingConfigured: boolean;
  modelPricingConfigured: boolean;
  webSearchPricingConfigured: boolean;
}

export interface ModelUsageCostSummary extends ModelUsageCost {
  pricedModelCallCount: number;
  unpricedModelCallCount: number;
  pricedWebSearchCallCount: number;
  unpricedWebSearchCallCount: number;
}

export interface CostedModelUsageWindowSummary extends ModelUsageWindowSummary {
  cost: ModelUsageCostSummary;
}

export interface CostedModelUsageEvent extends ModelUsageEvent {
  cost: ModelUsageCost;
}

export interface UsageSummary {
  generatedAt: string;
  budget: UsageBudgetConfig;
  safeguards: UsageSafeguardsConfig;
  pricing: UsagePricingConfig;
  today: CostedModelUsageWindowSummary;
  currentMonth: CostedModelUsageWindowSummary;
  allTime: CostedModelUsageWindowSummary;
  recentEvents: CostedModelUsageEvent[];
}

export class ModelUsageGovernance implements ModelUsageEventStore {
  private readonly store: ModelUsageEventStore;
  private readonly budget: UsageBudgetConfig;
  private readonly safeguards: UsageSafeguardsConfig;
  private readonly pricing: UsagePricingConfig;
  private readonly clientLocks = new Map<string, Promise<void>>();
  private readonly inFlightModelCalls = new Map<string, number>();

  constructor(options: ModelUsageGovernanceOptions) {
    this.store = options.store;
    this.budget = options.budget;
    this.safeguards = options.safeguards;
    this.pricing = normalizeUsagePricing(options.pricing);
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

  appendModelUsageEvent(input: ModelUsageEventInput): Promise<ModelUsageEvent> {
    return this.store.appendModelUsageEvent(input);
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
    const todayEvents = filterEventsByWindow(allEvents, todayStart);
    const currentMonthEvents = filterEventsByWindow(allEvents, currentMonthStart);
    const pricingCatalog = new UsagePricingCatalog(this.pricing, this.budget);

    return {
      generatedAt: now.toISOString(),
      budget: this.budget,
      safeguards: this.safeguards,
      pricing: this.pricing,
      today: summarizeCostedEvents(todayEvents, todayStart, undefined, pricingCatalog),
      currentMonth: summarizeCostedEvents(currentMonthEvents, currentMonthStart, undefined, pricingCatalog),
      allTime: summarizeCostedEvents(allEvents, undefined, undefined, pricingCatalog),
      recentEvents: allEvents.slice(0, 25).map((event) => ({
        ...event,
        cost: pricingCatalog.calculateEventCost(event)
      }))
    };
  }

  private async assertAllowed(clientInstanceId: ClientInstanceId): Promise<void> {
    if (
      !this.safeguards.modelCallsPerDay &&
      !this.safeguards.tokensPerDay &&
      !this.safeguards.tokensPerMonth &&
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
        const pricingCatalog = new UsagePricingCatalog(this.pricing, this.budget);
        const costedMonth = summarizeCostedEvents(
          currentMonthEvents,
          currentMonthStart,
          undefined,
          pricingCatalog
        );
        assertMonthlySpendBudget(costedMonth.cost, this.budget);
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

  private async withClientLock<T>(
    clientInstanceId: ClientInstanceId,
    work: () => Promise<T>
  ): Promise<T> {
    const key = clientInstanceId;
    const previous = this.clientLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(() => current);
    this.clientLocks.set(key, next);

    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.clientLocks.get(key) === next) {
        this.clientLocks.delete(key);
      }
    }
  }
}

function normalizeUsagePricing(pricing: UsagePricingConfig | undefined): UsagePricingConfig {
  return {
    currency: pricing?.currency ?? "USD",
    models: pricing?.models ?? [],
    webSearch: pricing?.webSearch ?? []
  };
}

function assertDailySafeguards(
  summary: ModelUsageWindowSummary,
  safeguards: UsageSafeguardsConfig,
  inFlightModelCallCount: number
): void {
  if (
    safeguards.modelCallsPerDay &&
    summary.modelCallCount + inFlightModelCallCount >= safeguards.modelCallsPerDay
  ) {
    throw new AppError("FORBIDDEN", "Daily model call safeguard has been reached");
  }

  if (safeguards.tokensPerDay && summary.totalTokens >= safeguards.tokensPerDay) {
    throw new AppError("FORBIDDEN", "Daily model token safeguard has been reached");
  }
}

function assertMonthlySpendBudget(cost: ModelUsageCostSummary, budget: UsageBudgetConfig): void {
  if (!budget.monthlySpendLimit) {
    return;
  }

  if (!cost.pricingConfigured) {
    throw new AppError(
      "FORBIDDEN",
      "Monthly model spend limit cannot be enforced because model pricing is missing"
    );
  }

  if (cost.budgetedCostMicros >= toMicros(budget.monthlySpendLimit)) {
    throw new AppError("FORBIDDEN", "Monthly model spend limit has been reached");
  }
}

function filterEventsByWindow(
  events: ModelUsageEvent[],
  start: string | undefined,
  end?: string
): ModelUsageEvent[] {
  return events.filter(
    (event) => (!start || event.createdAt >= start) && (!end || event.createdAt < end)
  );
}

function summarizeCostedEvents(
  events: ModelUsageEvent[],
  start: string | undefined,
  end: string | undefined,
  pricingCatalog: UsagePricingCatalog
): CostedModelUsageWindowSummary {
  return events.reduce<CostedModelUsageWindowSummary>(
    (summary, event) => {
      const cost = pricingCatalog.calculateEventCost(event);
      return {
        ...summary,
        modelCallCount: summary.modelCallCount + 1,
        inputTokens: summary.inputTokens + event.inputTokens,
        outputTokens: summary.outputTokens + event.outputTokens,
        totalTokens: summary.totalTokens + event.totalTokens,
        webSearchCallCount: summary.webSearchCallCount + event.webSearchCallCount,
        cost: {
          ...summary.cost,
          inputCostMicros: summary.cost.inputCostMicros + cost.inputCostMicros,
          outputCostMicros: summary.cost.outputCostMicros + cost.outputCostMicros,
          webSearchCostMicros: summary.cost.webSearchCostMicros + cost.webSearchCostMicros,
          totalCostMicros: summary.cost.totalCostMicros + cost.totalCostMicros,
          budgetedCostMicros: summary.cost.budgetedCostMicros + cost.budgetedCostMicros,
          pricingConfigured: summary.cost.pricingConfigured || cost.pricingConfigured,
          webSearchPricingConfigured:
            summary.cost.webSearchPricingConfigured && cost.webSearchPricingConfigured,
          pricedModelCallCount:
            summary.cost.pricedModelCallCount + (cost.modelPricingConfigured ? 1 : 0),
          unpricedModelCallCount:
            summary.cost.unpricedModelCallCount + (cost.modelPricingConfigured ? 0 : 1),
          pricedWebSearchCallCount:
            summary.cost.pricedWebSearchCallCount +
            (cost.webSearchPricingConfigured ? event.webSearchCallCount : 0),
          unpricedWebSearchCallCount:
            summary.cost.unpricedWebSearchCallCount +
            (cost.webSearchPricingConfigured ? 0 : event.webSearchCallCount)
        }
      };
    },
    {
      start,
      end,
      modelCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      webSearchCallCount: 0,
      cost: pricingCatalog.createEmptySummary()
    }
  );
}

class UsagePricingCatalog {
  private readonly modelPrices: UsagePricingConfig["models"];
  private readonly webSearchPrices: NonNullable<UsagePricingConfig["webSearch"]>;

  constructor(
    private readonly pricing: UsagePricingConfig,
    private readonly budget: UsageBudgetConfig
  ) {
    this.modelPrices = pricing.models;
    this.webSearchPrices = pricing.webSearch ?? [];
  }

  createEmptySummary(): ModelUsageCostSummary {
    return {
      ...this.createEmptyCost(
        this.modelPrices.length > 0 || this.webSearchPrices.length > 0,
        this.modelPrices.length > 0
      ),
      pricedModelCallCount: 0,
      unpricedModelCallCount: 0,
      pricedWebSearchCallCount: 0,
      unpricedWebSearchCallCount: 0
    };
  }

  calculateEventCost(event: ModelUsageEvent): ModelUsageCost {
    const modelPrice = this.modelPrices.find(
      (candidate) => candidate.providerId === event.providerId && candidate.model === event.model
    );
    const webSearchPrice = this.findWebSearchPrice(event);

    const inputCostMicros = modelPrice
      ? Math.ceil(event.inputTokens * modelPrice.inputPricePerMillionTokens)
      : 0;
    const outputCostMicros = modelPrice
      ? Math.ceil(event.outputTokens * modelPrice.outputPricePerMillionTokens)
      : 0;
    const webSearchCostMicros = webSearchPrice
      ? Math.ceil(event.webSearchCallCount * webSearchPrice.pricePerCall * 1_000_000)
      : 0;
    const totalCostMicros = inputCostMicros + outputCostMicros + webSearchCostMicros;
    const webSearchPricingConfigured = event.webSearchCallCount === 0 || Boolean(webSearchPrice);
    return {
      currency: this.pricing.currency,
      inputCostMicros,
      outputCostMicros,
      webSearchCostMicros,
      totalCostMicros,
      budgetedCostMicros: Math.ceil(totalCostMicros * this.budget.costSafetyMultiplier),
      costSafetyMultiplier: this.budget.costSafetyMultiplier,
      pricingConfigured:
        Boolean(modelPrice) || (event.webSearchCallCount > 0 && Boolean(webSearchPrice)),
      modelPricingConfigured: Boolean(modelPrice),
      webSearchPricingConfigured
    };
  }

  private findWebSearchPrice(event: ModelUsageEvent): NonNullable<UsagePricingConfig["webSearch"]>[number] | undefined {
    return (
      this.webSearchPrices.find(
        (candidate) => candidate.providerId === event.providerId && candidate.model === event.model
      ) ??
      this.webSearchPrices.find(
        (candidate) => candidate.providerId === event.providerId && candidate.model === undefined
      )
    );
  }

  private createEmptyCost(pricingConfigured: boolean, modelPricingConfigured = pricingConfigured): ModelUsageCost {
    return {
      currency: this.pricing.currency,
      inputCostMicros: 0,
      outputCostMicros: 0,
      webSearchCostMicros: 0,
      totalCostMicros: 0,
      budgetedCostMicros: 0,
      costSafetyMultiplier: this.budget.costSafetyMultiplier,
      pricingConfigured,
      modelPricingConfigured,
      webSearchPricingConfigured: true
    };
  }
}

function toMicros(value: number): number {
  return Math.floor(value * 1_000_000);
}
