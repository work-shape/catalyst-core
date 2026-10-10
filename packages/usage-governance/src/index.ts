import {
  AppError,
  ModelUsageLimitReachedError,
  type AdmittedModelCall,
  type ClientInstanceId,
  type ModelAttribution,
  type ModelCallAdmission,
  type ModelCallUsage,
  type ModelUsageAttributionGroup,
  type ModelUsageBudgetUsage,
  type ModelUsageBudgetWindow,
  type ModelUsageEvent,
  type ModelUsageEventInput,
  type ModelUsageEventRecordInput,
  type ModelUsageEventStore,
  type ModelUsageRecorder,
  type ModelUsageSettlement,
  type ModelUsageTotals,
  type ModelUsageWindowSummary,
  type UsageBudgetConfig,
  type UsageCostComponents,
  type UsageCostConfig,
  type UsageCostMissingMeter,
  type UsageCostRecord,
  type UsageRateCardConfig,
  type UsageRateCardTokenRatesConfig,
  type UsageSafeguardsConfig,
  createModelUsageWindowBounds,
  isBilledAsFast
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

/** What one purpose or one agent used of one model on one day. */
export interface SafeCostedModelUsageAttributionGroup
  extends
    SafeCostedModelUsageWindowSummary,
    Pick<
      ModelUsageAttributionGroup,
      "date" | "model" | "providerId" | "region" | "purpose" | "agentName"
    > {}

export type SafeModelUsageEvent = Pick<
  ModelUsageEvent,
  | "id"
  | "clientInstanceId"
  | "conversationId"
  | "agentRunId"
  | "agentName"
  | "purpose"
  | "providerId"
  | "model"
  | "region"
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "totalTokens"
  | "source"
  | "webSearchCallCount"
  | "correlationId"
  | "createdAt"
> & {
  /** The call was settled with the fast rates. */
  billedAsFast: boolean;
};

export interface SafeCostedModelUsageEvent extends SafeModelUsageEvent {
  cost: SafeModelUsageBillableCost;
}

export interface SafeUsageSpendBudget {
  currency?: string;
  dailyLimitMicros?: number;
  monthlyLimitMicros?: number;
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
  /** The days of `dailyUsage`, split by model, provider, region and purpose or agent. */
  attributedUsage: SafeCostedModelUsageAttributionGroup[];
  recentEvents: SafeCostedModelUsageEvent[];
}

/** The budget every call of an instance counts toward. Limits per user and workspace add keys. */
const INSTANCE_BUDGET_KEY = "instance";
const DAILY_USAGE_BUCKET_COUNT = 30;
const RECENT_EVENT_COUNT = 25;

/**
 * What a call counts as from its admission until it is settled, and for good when it never is:
 * one call that used nothing. A row that said "not reported" would count as an unpriced cost.
 */
const USAGE_BEFORE_SETTLEMENT: ModelCallUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  source: "estimated",
  webSearchCallCount: 0
};

export class ModelUsageGovernance implements ModelUsageRecorder {
  private readonly store: ModelUsageEventStore;
  private readonly budget: UsageBudgetConfig;
  private readonly safeguards: UsageSafeguardsConfig;
  private readonly costs: UsageCostConfig;

  constructor(options: ModelUsageGovernanceOptions) {
    this.store = options.store;
    this.budget = options.budget;
    this.safeguards = options.safeguards;
    this.costs = options.costs ?? {};
  }

  /**
   * Admits one model call or refuses it with the limit that is reached. The database decides:
   * the call's usage event is written in the transaction that read the budget under its lock,
   * so two processes cannot both admit the last call of a budget. The event counts as one call
   * from here on, whatever becomes of the call.
   */
  admitModelCall(call: ModelCallAdmission): Promise<AdmittedModelCall> {
    const { todayStart, currentMonthStart } = createModelUsageWindowBounds();
    return this.store.reserveModelUsageEvent({
      event: this.eventOf(call, USAGE_BEFORE_SETTLEMENT),
      ...(this.hasLimits()
        ? {
            admission: {
              budgetKey: INSTANCE_BUDGET_KEY,
              windows: {
                todayStart,
                ...(this.safeguards.tokensPerMonth || this.budget.monthlySpendLimit
                  ? { currentMonthStart }
                  : {})
              },
              decide: (usage) => assertWithinLimits(usage, this.safeguards, this.budget)
            }
          }
        : {})
    });
  }

  /** Writes what an admitted call used onto its usage event. */
  settleModelCall(admitted: AdmittedModelCall, usage: ModelCallUsage): Promise<ModelUsageEvent> {
    return this.store.settleModelUsageEvent({
      clientInstanceId: admitted.clientInstanceId,
      id: admitted.id,
      settlement: settlementOf(admitted, usage, this.costs.customer)
    });
  }

  /** Records usage of a call that was not admitted here, such as usage a tool reports. */
  recordModelUsage(input: ModelUsageEventInput): Promise<ModelUsageEvent> {
    return this.store.appendModelUsageEvent(this.eventOf(input, input));
  }

  async createSafeSummary(input: {
    clientInstanceId: ClientInstanceId;
    now?: Date;
    webSearchEnabled?: boolean;
  }): Promise<SafeUsageSummary> {
    const now = input.now ?? new Date();
    const { todayStart, currentMonthStart } = createModelUsageWindowBounds(now);
    const [history, recent, recentEvents] = await Promise.all([
      this.store.summarizeModelUsageHistory({ clientInstanceId: input.clientInstanceId }),
      this.store.summarizeRecentModelUsage({
        clientInstanceId: input.clientInstanceId,
        from: utcDayStart(now, 1 - DAILY_USAGE_BUCKET_COUNT).toISOString()
      }),
      this.store.listModelUsageEvents({
        clientInstanceId: input.clientInstanceId,
        limit: RECENT_EVENT_COUNT
      })
    ]);
    const rateCard = this.costs.customer;
    const showWebSearchCost =
      input.webSearchEnabled ??
      Boolean(rateCard?.webSearch?.length || history.allTime.webSearchCallCount > 0);
    const costed = (
      totals: ModelUsageTotals | undefined,
      start?: string,
      end?: string
    ): SafeCostedModelUsageWindowSummary =>
      toSafeWindow(totals ?? NO_USAGE, start, end, rateCard, showWebSearchCost);

    const days = new Map(recent.days.map((day) => [day.date, day]));
    const months = new Map(history.months.map((month) => [month.month, month]));
    const dailyUsage: SafeCostedModelUsageDailyBucket[] = [];
    for (let offset = 1 - DAILY_USAGE_BUCKET_COUNT; offset <= 0; offset += 1) {
      const start = utcDayStart(now, offset).toISOString();
      const date = start.slice(0, 10);
      dailyUsage.push({
        date,
        ...costed(days.get(date), start, utcDayStart(now, offset + 1).toISOString())
      });
    }
    // From the month of the first event to this one, months without an event included.
    const firstMonth = history.months[0]?.month ?? currentMonthStart.slice(0, 7);
    const firstMonthStart = new Date(`${firstMonth}-01T00:00:00.000Z`);
    const monthlyUsage: SafeCostedModelUsageMonthlyBucket[] = [];
    for (let offset = 0; utcMonthStart(firstMonthStart, offset) <= now; offset += 1) {
      const start = utcMonthStart(firstMonthStart, offset).toISOString();
      const month = start.slice(0, 7);
      monthlyUsage.push({
        month,
        ...costed(
          months.get(month),
          start,
          utcMonthStart(firstMonthStart, offset + 1).toISOString()
        )
      });
    }

    return {
      generatedAt: now.toISOString(),
      spendBudget: {
        ...(rateCard?.currency ? { currency: rateCard.currency } : {}),
        ...(this.budget.dailySpendLimit === undefined
          ? {}
          : { dailyLimitMicros: toMicros(this.budget.dailySpendLimit) }),
        ...(this.budget.monthlySpendLimit === undefined
          ? {}
          : { monthlyLimitMicros: toMicros(this.budget.monthlySpendLimit) })
      },
      safeguards: this.safeguards,
      today: costed(days.get(todayStart.slice(0, 10)), todayStart),
      currentMonth: costed(months.get(currentMonthStart.slice(0, 7)), currentMonthStart),
      allTime: costed(history.allTime),
      dailyUsage,
      monthlyUsage,
      attributedUsage: recent.byAttribution.map((group) => ({
        date: group.date,
        model: group.model,
        providerId: group.providerId,
        ...(group.region === undefined ? {} : { region: group.region }),
        ...(group.purpose === undefined ? {} : { purpose: group.purpose }),
        ...(group.agentName === undefined ? {} : { agentName: group.agentName }),
        ...costed(group)
      })),
      recentEvents: recentEvents.map((event) => toSafeEvent(event, showWebSearchCost))
    };
  }

  private hasLimits(): boolean {
    return Boolean(
      this.safeguards.modelCallsPerDay ||
      this.safeguards.tokensPerDay ||
      this.safeguards.tokensPerMonth ||
      this.budget.dailySpendLimit ||
      this.budget.monthlySpendLimit
    );
  }

  private eventOf(call: ModelCallAdmission, usage: ModelCallUsage): ModelUsageEventRecordInput {
    return {
      clientInstanceId: call.clientInstanceId,
      ...usageEventOrigin(call.attribution),
      providerId: call.providerId,
      model: call.model,
      ...(call.region === undefined ? {} : { region: call.region }),
      ...(call.bindingId === undefined ? {} : { bindingId: call.bindingId }),
      fastMode: call.fastMode === true,
      correlationId: call.correlationId,
      ...settlementOf(call, usage, this.costs.customer)
    };
  }
}

/** What a call used, its counts made whole numbers and its cost settled. */
function settlementOf(
  call: Pick<ModelCallAdmission, "providerId" | "model" | "fastMode">,
  usage: ModelCallUsage,
  rateCard: UsageRateCardConfig | undefined
): ModelUsageSettlement {
  const inputTokens = normalizeCount(usage.inputTokens);
  const measured = {
    inputTokens,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: Math.min(normalizeCount(usage.cachedInputTokens), inputTokens) }),
    outputTokens: normalizeCount(usage.outputTokens),
    totalTokens: normalizeCount(usage.totalTokens),
    source: usage.source,
    webSearchCallCount: normalizeCount(usage.webSearchCallCount ?? 0),
    ...(usage.providerServiceTier === undefined
      ? {}
      : { providerServiceTier: usage.providerServiceTier })
  };
  return {
    ...measured,
    customerBillableCost: calculateUsageCost(
      { providerId: call.providerId, model: call.model, fastMode: call.fastMode, ...measured },
      rateCard
    )
  };
}

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

/** Where a usage event says its call came from: a run with its agent, or a purpose. */
function usageEventOrigin(
  attribution: ModelAttribution
): Pick<
  ModelUsageEventRecordInput,
  | "conversationId"
  | "agentRunId"
  | "agentName"
  | "purpose"
  | "userId"
  | "collaborationWorkspaceId"
  | "operationRunId"
> {
  const who = {
    ...(attribution.userId === undefined ? {} : { userId: attribution.userId }),
    ...(attribution.workspaceId === undefined
      ? {}
      : { collaborationWorkspaceId: attribution.workspaceId })
  };
  if (attribution.kind === "agent_run") {
    return {
      ...who,
      conversationId: attribution.conversationId,
      agentRunId: attribution.runId,
      agentName: attribution.agentName
    };
  }
  return {
    ...who,
    ...(attribution.conversationId ? { conversationId: attribution.conversationId } : {}),
    ...(attribution.operationRunId ? { operationRunId: attribution.operationRunId } : {}),
    purpose: attribution.purpose
  };
}

const NO_USAGE: ModelUsageTotals = {
  modelCallCount: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  webSearchCallCount: 0,
  settledModelCallCount: 0,
  settledCost: {
    uncachedInputCostMicros: 0,
    cachedInputCostMicros: 0,
    outputCostMicros: 0,
    webSearchCostMicros: 0
  },
  settledCurrencyCount: 0,
  settledWebSearchCallCount: 0
};

/**
 * The sums of a window as the Usage page reads them. A cost is shown only when it is whole:
 * every event settled, in one currency.
 */
function toSafeWindow(
  totals: ModelUsageTotals,
  start: string | undefined,
  end: string | undefined,
  customerRateCard: UsageRateCardConfig | undefined,
  showWebSearchCost: boolean
): SafeCostedModelUsageWindowSummary {
  const empty = totals.modelCallCount === 0;
  const incomplete = totals.modelCallCount - totals.settledModelCallCount;
  const complete =
    incomplete === 0 &&
    totals.settledCurrencyCount <= 1 &&
    (!empty || customerRateCard !== undefined);
  const currency = totals.settledCurrency ?? (empty ? customerRateCard?.currency : undefined);
  const components = totals.settledCost;
  return {
    start,
    end,
    modelCallCount: totals.modelCallCount,
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    webSearchCallCount: totals.webSearchCallCount,
    cost: {
      status: complete
        ? "settled"
        : empty && customerRateCard === undefined
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
            billableCostMicros: totalComponents(components)
          }
        : {}),
      complete,
      webSearchCostVisible: showWebSearchCost,
      settledModelCallCount: totals.settledModelCallCount,
      incompleteModelCallCount: incomplete,
      settledWebSearchCallCount: totals.settledWebSearchCallCount,
      incompleteWebSearchCallCount: totals.webSearchCallCount - totals.settledWebSearchCallCount
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
    ...(event.purpose === undefined ? {} : { purpose: event.purpose }),
    providerId: event.providerId,
    model: event.model,
    ...(event.region === undefined ? {} : { region: event.region }),
    inputTokens: event.inputTokens,
    ...(event.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: event.cachedInputTokens }),
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
    source: event.source,
    webSearchCallCount: event.webSearchCallCount,
    billedAsFast: isBilledAsFast(event),
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

/**
 * Holds what the windows hold against the limits of the instance, and throws the one that is
 * reached. An admitted call counts from its admission, so calls in flight count too.
 */
function assertWithinLimits(
  usage: ModelUsageBudgetUsage,
  safeguards: UsageSafeguardsConfig,
  budget: UsageBudgetConfig
): void {
  const { today } = usage;
  if (safeguards.modelCallsPerDay && today.modelCallCount >= safeguards.modelCallsPerDay) {
    throw new ModelUsageLimitReachedError("Daily model call safeguard has been reached");
  }
  if (safeguards.tokensPerDay && today.totalTokens >= safeguards.tokensPerDay) {
    throw new ModelUsageLimitReachedError("Daily model token safeguard has been reached");
  }
  const costSafetyMultiplier = budget.costSafetyMultiplier ?? 1;
  if (budget.dailySpendLimit) {
    assertSpendBudget(today, budget.dailySpendLimit, costSafetyMultiplier, "Daily");
  }
  if (!safeguards.tokensPerMonth && !budget.monthlySpendLimit) return;
  const { currentMonth } = usage;
  if (!currentMonth) throw new AppError("INTERNAL", "Admission did not read the month");
  if (safeguards.tokensPerMonth && currentMonth.totalTokens >= safeguards.tokensPerMonth) {
    throw new ModelUsageLimitReachedError("Monthly model token safeguard has been reached");
  }
  if (budget.monthlySpendLimit) {
    assertSpendBudget(currentMonth, budget.monthlySpendLimit, costSafetyMultiplier, "Monthly");
  }
}

function assertSpendBudget(
  window: ModelUsageBudgetWindow,
  limit: number,
  costSafetyMultiplier: number,
  label: "Daily" | "Monthly"
): void {
  if (window.unsettledModelCallCount > 0) {
    throw new AppError(
      "FORBIDDEN",
      `${label} customer billable cost is incomplete; spend budget cannot be evaluated safely`
    );
  }
  if (window.settledCostMicros * costSafetyMultiplier >= toMicros(limit)) {
    throw new ModelUsageLimitReachedError(`${label} model spend budget has been reached`);
  }
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
