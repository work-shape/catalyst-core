import {
  AppError,
  ModelUsageLimitReachedError,
  type AdmittedModelCall,
  type ClientInstanceId,
  type ModelAttribution,
  type ModelCallAdmission,
  type ModelCallUsage,
  type ModelUsageAttributionGroup,
  type ModelUsageCounted,
  type ModelUsageCounterLimits,
  type ModelUsageEvent,
  type ModelUsageEventInput,
  type ModelUsageEventRecordInput,
  type ModelUsageEventStore,
  type ModelUsageRecorder,
  type ModelUsageRefusal,
  type ModelUsageSettlement,
  type ModelUsageTotals,
  type ModelUsageWindowSummary,
  type UsageBudgetConfig,
  type UsageCostConfig,
  type UsageCostRecord,
  type UsageRateCardConfig,
  type UsageRateCardTokenRatesConfig,
  type UsageSafeguardsConfig,
  createModelUsageWindowBounds,
  isBilledAsFast
} from "@vivd-catalyst/core";
import { calculateUsageCost, normalizeCount, priceTokens, totalComponents } from "./cost";

export { calculateUsageCost, type UsageCostEvent } from "./cost";

export interface ModelUsageGovernanceOptions {
  store: ModelUsageEventStore;
  budget: UsageBudgetConfig;
  safeguards: UsageSafeguardsConfig;
  costs?: UsageCostConfig;
  /** What a test sets to have recovery take a call as abandoned sooner. */
  abandonedAfterMs?: number;
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
  | "status"
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

const DAILY_USAGE_BUCKET_COUNT = 30;
const RECENT_EVENT_COUNT = 25;

/**
 * Characters taken as one input token when a request is sized before it is sent. Text runs at
 * about four characters a token; three keeps the reservation above what the provider counts.
 */
const RESERVED_CHARACTERS_PER_INPUT_TOKEN = 3;
/** Output tokens reserved for a call whose request states no maximum. */
const RESERVED_OUTPUT_TOKENS = 16_000;
/**
 * How long a call may stay `pending` before recovery takes it as abandoned and releases its
 * reservation. Well above any call: a call that still ends after it is settled all the same.
 */
const USAGE_ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000;
/** Abandoned calls recovery releases between two looks at whether it was stopped. */
const USAGE_RECOVERY_BATCH = 200;

/** What a call that reported nothing is settled with. */
const NOTHING_REPORTED: ModelCallUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  source: "not_reported",
  webSearchCallCount: 0
};

export class ModelUsageGovernance implements ModelUsageRecorder {
  private readonly store: ModelUsageEventStore;
  private readonly budget: UsageBudgetConfig;
  private readonly safeguards: UsageSafeguardsConfig;
  private readonly costs: UsageCostConfig;
  private readonly abandonedAfterMs: number;

  constructor(options: ModelUsageGovernanceOptions) {
    this.store = options.store;
    this.budget = options.budget;
    this.safeguards = options.safeguards;
    this.costs = options.costs ?? {};
    this.abandonedAfterMs = options.abandonedAfterMs ?? USAGE_ABANDONED_AFTER_MS;
  }

  /**
   * Admits one model call or refuses it with the limit that is reached. The database decides
   * in one statement: it adds one call and the call's reservation to the counters of the day
   * and the month when every limit still holds afterwards, and writes the usage event as
   * `pending`. Of any number of processes that ask at once, exactly as many are admitted as
   * the limits have room for. The event counts as one call from here on, whatever becomes of
   * the call.
   */
  async admitModelCall(call: ModelCallAdmission): Promise<AdmittedModelCall> {
    const reserved = this.reservationOf(call);
    const admitted = await this.store.admitModelUsageEvent({
      event: this.eventOf(call, NOTHING_REPORTED),
      reservation: reserved,
      limits: this.limits()
    });
    if ("refused" in admitted) throw refusalError(admitted.refused);
    return {
      id: admitted.id,
      clientInstanceId: call.clientInstanceId,
      providerId: call.providerId,
      model: call.model,
      fastMode: call.fastMode === true,
      reserved
    };
  }

  /**
   * Ends an admitted call: writes what it used onto its usage event and replaces its
   * reservation on the counters by that. A call that ended without an answer passes no usage:
   * it is settled as `failed` with nothing used, and its reservation is released.
   */
  async settleModelCall(admitted: AdmittedModelCall, usage?: ModelCallUsage): Promise<void> {
    const settlement = settlementOf(admitted, usage ?? NOTHING_REPORTED, this.costs.customer);
    await this.store.settleModelUsageEvent({
      clientInstanceId: admitted.clientInstanceId,
      id: admitted.id,
      // Recovery may have taken a call that ran very long as abandoned. It ends all the same.
      from: ["pending", "abandoned"],
      status: usage ? "settled" : "failed",
      settlement,
      counted: usage ? countedOf(settlement, admitted.reserved) : NOTHING_COUNTED
    });
  }

  /**
   * Takes the calls that were admitted more than `USAGE_ABANDONED_AFTER_MS` ago and never
   * ended as abandoned: nothing used, the reservation released. Resolves with how many.
   */
  async releaseAbandonedModelCalls(input: {
    clientInstanceId: ClientInstanceId;
    signal?: AbortSignal;
  }): Promise<number> {
    let released = 0;
    while (!input.signal?.aborted) {
      const abandoned = await this.store.listPendingModelUsageEvents({
        clientInstanceId: input.clientInstanceId,
        olderThanMs: this.abandonedAfterMs,
        limit: USAGE_RECOVERY_BATCH
      });
      for (const call of abandoned) {
        const changed = await this.store.settleModelUsageEvent({
          clientInstanceId: call.clientInstanceId,
          id: call.id,
          from: ["pending"],
          status: "abandoned",
          settlement: settlementOf(call, NOTHING_REPORTED, this.costs.customer),
          counted: NOTHING_COUNTED
        });
        if (changed) released += 1;
      }
      if (abandoned.length < USAGE_RECOVERY_BATCH) break;
    }
    return released;
  }

  /** Records usage of a call that was not admitted here, such as usage a tool reports. */
  recordModelUsage(input: ModelUsageEventInput): Promise<ModelUsageEvent> {
    const event = this.eventOf(input, input);
    // Nothing was reserved for it. Where its cost is not whole, its tokens count at the
    // highest price of the model, so an unknown cost never counts as none.
    return this.store.appendModelUsageEvent(
      event,
      countedOf(event, {
        tokens: event.totalTokens,
        costMicros: this.highestCost(input, event.inputTokens, event.outputTokens) ?? 0
      })
    );
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

  private limits(): { day: ModelUsageCounterLimits; month: ModelUsageCounterLimits } {
    const { safeguards, budget } = this;
    // A counter holds costs as they are settled. The safety multiplier lowers the limit.
    const spend = (limit: number | undefined): { costMicros?: number } =>
      limit ? { costMicros: Math.floor(toMicros(limit) / (budget.costSafetyMultiplier ?? 1)) } : {};
    return {
      day: {
        ...(safeguards.modelCallsPerDay ? { modelCallCount: safeguards.modelCallsPerDay } : {}),
        ...(safeguards.tokensPerDay ? { tokens: safeguards.tokensPerDay } : {}),
        ...spend(budget.dailySpendLimit)
      },
      month: {
        ...(safeguards.tokensPerMonth ? { tokens: safeguards.tokensPerMonth } : {}),
        ...spend(budget.monthlySpendLimit)
      }
    };
  }

  /**
   * The most a call can use, taken from its request before it is sent: the input by its size,
   * the output by the request's maximum, and both at the highest price the rate card has for
   * the model. With a spend budget, a model without a price is refused: nothing bounds what
   * its call costs.
   */
  private reservationOf(call: ModelCallAdmission): ModelUsageCounted {
    const inputTokens = Math.ceil(
      normalizeCount(call.request.inputCharacters) / RESERVED_CHARACTERS_PER_INPUT_TOKEN
    );
    const outputTokens = normalizeCount(call.request.maxOutputTokens ?? RESERVED_OUTPUT_TOKENS);
    const tokens = inputTokens + outputTokens;
    const costMicros = this.highestCost(call, inputTokens, outputTokens);
    if (
      costMicros === undefined &&
      (this.budget.dailySpendLimit || this.budget.monthlySpendLimit)
    ) {
      throw new AppError(
        "FORBIDDEN",
        "The model has no price on the rate card; the spend budget cannot be evaluated safely"
      );
    }
    return { tokens, costMicros: costMicros ?? 0 };
  }

  /** What the tokens cost at the highest price the rate card has for the model, if it has one. */
  private highestCost(
    call: Pick<ModelCallAdmission, "providerId" | "model" | "fastMode">,
    inputTokens: number,
    outputTokens: number
  ): number | undefined {
    const rate = this.costs.customer?.models.find(
      (candidate) => candidate.providerId === call.providerId && candidate.model === call.model
    );
    if (!rate || (call.fastMode && !rate.fast)) return undefined;
    // A call asked for as fast may be billed at either rate.
    const rates: UsageRateCardTokenRatesConfig[] = [
      rate,
      ...(call.fastMode && rate.fast ? [rate.fast] : [])
    ];
    const highest = (price: (rates: UsageRateCardTokenRatesConfig) => number): number =>
      Math.max(...rates.map(price));
    return (
      priceTokens(
        inputTokens,
        highest((candidate) =>
          Math.max(
            candidate.uncachedInputPricePerMillionTokens,
            candidate.cachedInputPricePerMillionTokens
          )
        )
      ) +
      priceTokens(
        outputTokens,
        highest((candidate) => candidate.outputPricePerMillionTokens)
      )
    );
  }

  private eventOf(
    call: Omit<ModelCallAdmission, "request">,
    usage: ModelCallUsage
  ): ModelUsageEventRecordInput {
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

const NOTHING_COUNTED: ModelUsageCounted = { tokens: 0, costMicros: 0 };

/**
 * What an ended call holds on its counters: what it used where that is known. Where the
 * provider reported no tokens, or the cost cannot be settled, the reservation stays, so an
 * unknown amount never counts as none.
 */
function countedOf(
  settlement: ModelUsageSettlement,
  reserved: ModelUsageCounted
): ModelUsageCounted {
  const cost = settlement.customerBillableCost;
  return {
    tokens: settlement.source === "not_reported" ? reserved.tokens : settlement.totalTokens,
    costMicros: cost.status === "settled" ? cost.totalCostMicros : reserved.costMicros
  };
}

function refusalError(refusal: ModelUsageRefusal): ModelUsageLimitReachedError {
  const period = refusal.period === "day" ? "Daily" : "Monthly";
  if (refusal.metric === "modelCallCount")
    return new ModelUsageLimitReachedError(`${period} model call safeguard has been reached`);
  if (refusal.metric === "tokens")
    return new ModelUsageLimitReachedError(`${period} model token safeguard has been reached`);
  return new ModelUsageLimitReachedError(`${period} model spend budget has been reached`);
}

/**
 * What a call used, its counts made whole numbers and its cost settled. A call that reported
 * nothing costs nothing: its cost is settled at zero, not left open.
 */
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
      {
        providerId: call.providerId,
        model: call.model,
        fastMode: call.fastMode,
        ...measured,
        ...(usage === NOTHING_REPORTED ? { source: "estimated" as const } : {})
      },
      rateCard
    )
  };
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
    // Transition release only: the Usage page of the previous release reads the purpose of a
    // call the product made for itself from the agent name. It goes in the contract step.
    agentName: attribution.purpose,
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
    status: event.status,
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
