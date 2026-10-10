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
import type { JsonObject } from "./json";

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

/**
 * Where the call of a usage event stands. `pending`: admitted and not ended. `settled`: ended
 * with the usage its provider reported, or with an estimate when it was cut off after its
 * answer began; the event's `source` says which. `failed`: ended before any answer arrived.
 * `abandoned`: never ended as far as the instance knows, because its process went away.
 */
export type ModelUsageEventStatus = "pending" | "settled" | "failed" | "abandoned";

export interface ModelUsageEvent extends ModelTokenUsage {
  id: ModelUsageEventId;
  status: ModelUsageEventStatus;
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
  /** The size of the request. Admission reserves tokens and cost from it. */
  request: ModelCallRequestSize;
}

/** What admission knows of a request before it is sent. */
export interface ModelCallRequestSize {
  /** The characters of the messages and tool definitions. */
  inputCharacters: number;
  /** The most tokens the answer may have, where the request states it. */
  maxOutputTokens?: number;
}

/** A call that was admitted: its usage event, which settlement completes. */
export interface AdmittedModelCall extends Pick<
  ModelUsageEvent,
  "id" | "clientInstanceId" | "providerId" | "model" | "fastMode"
> {
  /** What the call holds on the counters of its day and month until it ends. */
  reserved: ModelUsageCounted;
}

/** What a call used, as its provider reported it or as it is estimated. */
export interface ModelCallUsage extends ModelTokenUsage {
  webSearchCallCount?: number;
  providerServiceTier?: string;
}

export interface ModelUsageEventInput extends Omit<ModelCallAdmission, "request">, ModelCallUsage {}

export interface ModelUsageEventRecordInput extends ModelTokenUsage {
  clientInstanceId: ClientInstanceId;
  conversationId?: ConversationId;
  agentRunId?: AgentRunId;
  /** The agent of the run. A call the product made for itself carries its purpose here too. */
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

/** What a usage event holds on the counters of its day and month. */
export interface ModelUsageCounted {
  tokens: number;
  costMicros: number;
}

/** The most a period's counter may hold. An absent metric is not limited. */
export interface ModelUsageCounterLimits {
  modelCallCount?: number;
  tokens?: number;
  costMicros?: number;
}

/** The limit that refused a call. */
export interface ModelUsageRefusal {
  period: "day" | "month";
  metric: "modelCallCount" | "tokens" | "costMicros";
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
  /**
   * Writes the event of a call nobody admitted, such as usage a tool reports, and adds it to
   * the counters of its day and month and to the sums of its day. Without `counted` the
   * counters take its tokens and its settled cost.
   */
  appendModelUsageEvent(
    input: ModelUsageEventRecordInput,
    counted?: ModelUsageCounted
  ): Promise<ModelUsageEvent>;
  /**
   * Admits a call in one statement: it adds one call and the reservation to the counters of the
   * instance's day and month when every limit still holds afterwards, and writes the event as
   * `pending` with it. Otherwise it changes nothing and names the limit. The day and the month
   * are those of the database clock. It reads no usage event, except once per period to start
   * a counter that does not exist yet from the events the period already has.
   */
  admitModelUsageEvent(input: {
    event: ModelUsageEventRecordInput;
    reservation: ModelUsageCounted;
    limits: { day: ModelUsageCounterLimits; month: ModelUsageCounterLimits };
  }): Promise<{ id: ModelUsageEventId } | { refused: ModelUsageRefusal }>;
  /**
   * Ends the call of an event in one statement: writes what it used and its status, replaces
   * what the event held on its counters by `counted`, and adds the event to the sums of its
   * day. It changes an event only while its status is one of `from`, and resolves with whether
   * it did.
   */
  settleModelUsageEvent(input: {
    clientInstanceId: ClientInstanceId;
    id: ModelUsageEventId;
    from: readonly ModelUsageEventStatus[];
    status: Exclude<ModelUsageEventStatus, "pending">;
    settlement: ModelUsageSettlement;
    counted: ModelUsageCounted;
  }): Promise<boolean>;
  /** Up to `limit` events that are `pending` and were admitted more than `olderThanMs` ago. */
  listPendingModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    olderThanMs: number;
    limit: number;
  }): Promise<AdmittedModelCall[]>;
  /** The sums of every day of the instance: in total and by UTC month. Reads no usage event. */
  summarizeModelUsageHistory(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<ModelUsageHistory>;
  /** The sums of the days from `from` on. Reads no usage event. */
  summarizeRecentModelUsage(input: {
    clientInstanceId: ClientInstanceId;
    from: ISODateString;
  }): Promise<RecentModelUsage>;
  /**
   * Compares the counters of the current day and month and the daily sums with the usage
   * events, and corrects what differs, such as what a process of the previous release wrote.
   * `recent` reads the events from the start of the month, or of the month of `since` where
   * that is earlier; `all` reads every event. Each comparison is one statement on one snapshot
   * and its correction is added, not set, so calls that are admitted or end meanwhile stay
   * counted. One reconciliation of an instance runs at a time: a second waits for the first
   * to commit before it reads. It takes no lock that admission or settlement waits for.
   */
  reconcileModelUsage(input: {
    clientInstanceId: ClientInstanceId;
    scope: "recent" | "all";
    /** When the reconciliation before this one ran. */
    since?: ISODateString;
  }): Promise<{ correctedCounters: number; correctedSums: number }>;
  readModelUsageMaintenance(input: {
    clientInstanceId: ClientInstanceId;
    task: string;
  }): Promise<JsonObject | undefined>;
  writeModelUsageMaintenance(input: {
    clientInstanceId: ClientInstanceId;
    task: string;
    state: JsonObject;
  }): Promise<void>;
  listModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: ISODateString;
    end?: ISODateString;
    limit?: number;
    page?: StorePage;
  }): Promise<ModelUsageEvent[]>;
  /**
   * Takes the user off up to `limit` usage events, with what leads back to them: the
   * conversation, the run, the operation and the correlation id. Resolves with how many it
   * changed. The amounts stay. The deletion of an account calls it until it resolves with 0.
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
