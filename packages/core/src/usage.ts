import type { StorePage } from "./paging";
import type {
  AgentRunId,
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  ModelUsageEventId,
  UserId
} from "./ids";
import type { ISODateString } from "./time";
import type { ProviderRegion } from "./providers";

export type ModelUsageSource = "provider_reported" | "not_reported" | "estimated";

export interface ModelTokenUsage {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
  source: ModelUsageSource;
}

export type UsageCostRecordSource = "rate_card" | "backfilled" | "provider_reconciled";
export type UsageCostRecordStatus = "settled" | "incomplete" | "unpriced";
export type UsageCostMissingMeter =
  "token_usage" | "cached_input_tokens" | "model_rate" | "fast_model_rate" | "web_search_rate";

export interface UsageCostAppliedRates {
  uncachedInputPricePerMillionTokens: number;
  cachedInputPricePerMillionTokens: number;
  outputPricePerMillionTokens: number;
  webSearchPricePerCall?: number;
}

export interface UsageCostComponents {
  uncachedInputCostMicros: number;
  cachedInputCostMicros: number;
  outputCostMicros: number;
  webSearchCostMicros: number;
}

export interface UsageCostRecordProvenance {
  source: UsageCostRecordSource;
  calculationVersion: 1;
  rateCardId: string;
  rateCardVersion: string;
  currency: string;
  appliedRates: UsageCostAppliedRates;
}

export interface SettledUsageCostRecord extends UsageCostRecordProvenance {
  status: "settled";
  components: UsageCostComponents;
  totalCostMicros: number;
}

export interface IncompleteUsageCostRecord extends Partial<UsageCostRecordProvenance> {
  status: "incomplete" | "unpriced";
  source: UsageCostRecordSource;
  calculationVersion: 1;
  knownComponents?: UsageCostComponents;
  knownCostMicros?: number;
  missingMeters: UsageCostMissingMeter[];
}

export type UsageCostRecord = SettledUsageCostRecord | IncompleteUsageCostRecord;

export interface ModelUsageEvent extends ModelTokenUsage {
  id: ModelUsageEventId;
  clientInstanceId: ClientInstanceId;
  /** Absent for a call no conversation caused. */
  conversationId?: ConversationId;
  /** Absent for a call the product made for itself. */
  agentRunId?: AgentRunId;
  /** The agent of the run. A call the product made for itself carries its purpose here too. */
  agentName: string;
  /** What a call the product made for itself was for. Absent for a call of an agent run. */
  purpose?: ModelSystemPurpose;
  providerId: string;
  model: string;
  /** Where the provider processed the call. Absent for a provider inside the instance. */
  region?: ProviderRegion;
  /** The model binding the call went through. Absent for a call on a provider entry alone. */
  bindingId?: string;
  /** The acting user. Absent when there was none, and once that user's account is deleted. */
  userId?: UserId;
  /** The workspace the usage happened in. Absent once that workspace is deleted. */
  collaborationWorkspaceId?: CollaborationWorkspaceId;
  operationRunId?: string;
  webSearchCallCount: number;
  /** The call was requested in fast mode. See `isBilledAsFast` for the rates it is settled with. */
  fastMode: boolean;
  /** Service tier the provider reported for the call, where it reports one. */
  providerServiceTier?: string;
  customerBillableCost: UsageCostRecord;
  correlationId: string;
  createdAt: ISODateString;
}

/** What a model call that no agent run made was for. */
export type ModelSystemPurpose = "conversation_title" | "guardrail_judge" | "document_extraction";

/** A model call an agent run made. */
export interface AgentRunModelAttribution {
  kind: "agent_run";
  conversationId: ConversationId;
  runId: AgentRunId;
  agentName: string;
  userId: string;
  workspaceId?: string;
}

/** A model call the product made for itself. */
export interface SystemModelAttribution {
  kind: "system";
  purpose: ModelSystemPurpose;
  userId?: string;
  workspaceId?: string;
  conversationId?: ConversationId;
  operationRunId?: string;
}

/** Who and what caused a model call. Admission and the usage event both read it. */
export type ModelAttribution = AgentRunModelAttribution | SystemModelAttribution;

/** What a model call is admitted with: who and what it is for, and which model answers it. */
export interface ModelCallAdmission {
  clientInstanceId: ClientInstanceId;
  attribution: ModelAttribution;
  providerId: string;
  model: string;
  /** Where the provider entry processes data. */
  region?: ProviderRegion;
  /** The model binding the call names, when it names one. */
  bindingId?: string;
  fastMode?: boolean;
  /** Ties the usage event to the request that caused the call. */
  correlationId: string;
}

/** A call that was admitted: its usage event, which settlement completes. */
export type AdmittedModelCall = Pick<
  ModelUsageEvent,
  "id" | "clientInstanceId" | "providerId" | "model" | "fastMode"
>;

/** What a call used, as its provider reported it or as it is estimated. */
export interface ModelCallUsage extends ModelTokenUsage {
  webSearchCallCount?: number;
  providerServiceTier?: string;
}

export interface ModelUsageEventInput extends ModelCallAdmission, ModelCallUsage {}

export interface ModelUsageEventRecordInput extends ModelTokenUsage {
  clientInstanceId: ClientInstanceId;
  conversationId?: ConversationId;
  agentRunId?: AgentRunId;
  /** The agent of the run. Absent for a call the product made for itself. */
  agentName?: string;
  purpose?: ModelSystemPurpose;
  providerId: string;
  model: string;
  region?: ProviderRegion;
  bindingId?: string;
  /** Written only while the user exists and their account is not being deleted. */
  userId?: string;
  /** Written only while the workspace exists and is not being deleted. */
  collaborationWorkspaceId?: string;
  operationRunId?: string;
  webSearchCallCount: number;
  fastMode: boolean;
  providerServiceTier?: string;
  customerBillableCost: UsageCostRecord;
  correlationId: string;
}

/** What settlement writes onto the usage event of an admitted call. */
export type ModelUsageSettlement = Pick<
  ModelUsageEventRecordInput,
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "totalTokens"
  | "source"
  | "webSearchCallCount"
  | "providerServiceTier"
  | "customerBillableCost"
>;

/**
 * A call requested as fast is settled with the fast rates unless the provider explicitly
 * reported another tier, as it does when it downgrades the call to standard processing.
 */
export function isBilledAsFast(event: {
  fastMode?: boolean;
  providerServiceTier?: string;
}): boolean {
  return (
    event.fastMode === true &&
    (event.providerServiceTier === undefined || event.providerServiceTier === "priority")
  );
}

export interface ModelUsageWindowSummary {
  start?: ISODateString;
  end?: ISODateString;
  modelCallCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  webSearchCallCount: number;
}

export interface ModelUsageWindowBounds {
  todayStart: ISODateString;
  currentMonthStart: ISODateString;
}

/** The sums of a set of usage events, with the settled cost of those that have one. */
export interface ModelUsageTotals extends Omit<ModelUsageWindowSummary, "start" | "end"> {
  /** Events whose cost is settled. The rest are incomplete or unpriced. */
  settledModelCallCount: number;
  /** The cost components of the settled events, summed. */
  settledCost: UsageCostComponents;
  /** How many currencies the settled events were settled in. */
  settledCurrencyCount: number;
  /** One of those currencies. The only one when the count is 1. */
  settledCurrency?: string;
  /** Web searches of the settled events. */
  settledWebSearchCallCount: number;
}

/** One group of the usage summary: what one purpose used of one model on one day. */
export interface ModelUsageAttributionGroup extends ModelUsageTotals {
  /** UTC day, `YYYY-MM-DD`. */
  date: string;
  model: string;
  providerId: string;
  region?: string;
  /** The purpose of a call the product made for itself. */
  purpose?: string;
  /** The agent of the runs in the group. */
  agentName?: string;
}

/** Everything an instance used, summed by the database: in total and by UTC month. */
export interface ModelUsageHistory {
  allTime: ModelUsageTotals;
  /** Oldest first. Months without an event are absent. */
  months: Array<ModelUsageTotals & { month: string }>;
}

/** What an instance used from a moment on, summed by the database by UTC day. */
export interface RecentModelUsage {
  /** Oldest first. Days without an event are absent. */
  days: Array<ModelUsageTotals & { date: string }>;
  /** The same days, split by model, provider, region and purpose or agent. */
  byAttribution: ModelUsageAttributionGroup[];
}

/** What admission reads of one window: enough to hold it against every instance limit. */
export interface ModelUsageBudgetWindow {
  modelCallCount: number;
  totalTokens: number;
  /** Events whose cost is not settled. A spend budget cannot be evaluated while there are any. */
  unsettledModelCallCount: number;
  settledCostMicros: number;
}

export interface ModelUsageBudgetUsage {
  today: ModelUsageBudgetWindow;
  /** Absent when admission asked for the day alone. */
  currentMonth?: ModelUsageBudgetWindow;
}

/**
 * Where a backfill call ended: the creation time, as the database writes it, and the id of the
 * last event it read. Events are stored in the order of their creation time, so a batch in
 * that order reads and writes neighbouring pages.
 */
export interface ModelUsageBackfillPosition {
  createdAt: string;
  id: string;
}

/** One provider and model of the instance today, for attributing events written before attribution was recorded. */
export interface ModelUsageBackfillTarget {
  providerId: string;
  model: string;
  region?: ProviderRegion;
  bindingId?: string;
}

export interface ModelUsageEventStore {
  /** Writes the event of a call nobody admitted, such as usage a tool reports. */
  appendModelUsageEvent(input: ModelUsageEventRecordInput): Promise<ModelUsageEvent>;
  /**
   * Admits a call and writes its event in one transaction. With `admission` it first takes the
   * lock of the instance's budget, reads what the windows hold and calls `decide`, which throws
   * to refuse; of two processes that ask at once the second sees the first one's event. The
   * event stands for the call from here on: it counts as one call with no tokens until
   * `settleModelUsageEvent` writes what the call used.
   */
  reserveModelUsageEvent(input: {
    event: ModelUsageEventRecordInput;
    admission?: {
      budgetKey: string;
      /**
       * The windows to read. Without the start of the month only the events of the day are
       * read, which is all an instance without a monthly limit needs.
       */
      windows: { todayStart: ISODateString; currentMonthStart?: ISODateString };
      decide(usage: ModelUsageBudgetUsage): void;
    };
  }): Promise<ModelUsageEvent>;
  settleModelUsageEvent(input: {
    clientInstanceId: ClientInstanceId;
    id: ModelUsageEventId;
    settlement: ModelUsageSettlement;
  }): Promise<ModelUsageEvent>;
  /** Reads every event of the instance once. */
  summarizeModelUsageHistory(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<ModelUsageHistory>;
  /** Reads the events from `from` on, through the index on instance and creation time. */
  summarizeRecentModelUsage(input: {
    clientInstanceId: ClientInstanceId;
    from: ISODateString;
  }): Promise<RecentModelUsage>;
  listModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: ISODateString;
    end?: ISODateString;
    limit?: number;
    page?: StorePage;
  }): Promise<ModelUsageEvent[]>;
  /**
   * Takes the user off up to `limit` usage events and resolves with how many it changed. The
   * amounts stay. The deletion of an account calls it until it resolves with 0.
   */
  clearUserFromModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserId;
    limit: number;
  }): Promise<number>;
  /** The same for the events of a workspace that is being deleted. */
  clearWorkspaceFromModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    limit: number;
  }): Promise<number>;
  /**
   * Fills what events written before attribution was recorded lack, for the next `limit` events after `after` in
   * the order they were written in: the purpose from the agent name of a title or an approval
   * check, region and binding from the target with the event's provider and model, user and
   * workspace from the run and the conversation that still exist. A value that is set is never
   * changed. `next` is where the following call goes on, and is absent after the last event.
   */
  backfillModelUsageAttribution(input: {
    clientInstanceId: ClientInstanceId;
    targets: readonly ModelUsageBackfillTarget[];
    after?: ModelUsageBackfillPosition;
    limit: number;
  }): Promise<{ next?: ModelUsageBackfillPosition; changedCount: number }>;
}

export interface ModelUsageRecorder {
  recordModelUsage(input: ModelUsageEventInput): Promise<ModelUsageEvent>;
}

export function createModelUsageWindowBounds(now = new Date()): ModelUsageWindowBounds {
  return {
    todayStart: startOfUtcDay(now).toISOString(),
    currentMonthStart: startOfUtcMonth(now).toISOString()
  };
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
