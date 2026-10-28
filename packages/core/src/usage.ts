import {
  MODEL_USAGE_EVENT_STATUSES,
  MODEL_USAGE_SOURCES,
  PERSONAL_AGENTS_KEY,
  PERSONAL_WORKSPACES_KEY,
  USAGE_BREAKDOWN_DIMENSIONS,
  USAGE_COST_STATUSES,
  USAGE_ORIGINS,
  USAGE_SPEND_LIMIT_LEVELS
} from "@work-shape/catalyst-asset-schemas";
import type {
  AgentRunId,
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  ModelUsageEventId,
  UserId
} from "./ids";
import type { ModelUsageRefusal } from "./errors";
import type { JsonObject } from "./json";
import type { StorePage } from "./paging";
import type { ProviderRegion } from "./providers";
import type { ISODateString } from "./time";

export type ModelUsageSource = (typeof MODEL_USAGE_SOURCES)[number];

export interface ModelTokenUsage {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
  source: ModelUsageSource;
}

export type UsageCostRecordSource = "rate_card" | "backfilled" | "provider_reconciled";
export type UsageCostRecordStatus = (typeof USAGE_COST_STATUSES)[number];
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
export type ModelUsageEventStatus = (typeof MODEL_USAGE_EVENT_STATUSES)[number];

export interface ModelUsageEvent extends ModelTokenUsage {
  id: ModelUsageEventId;
  status: ModelUsageEventStatus;
  clientInstanceId: ClientInstanceId;
  /** Absent for a call no conversation caused. */
  conversationId?: ConversationId;
  /** Absent for a call the product made for itself. */
  agentRunId?: AgentRunId;
  workflowRunId?: string;
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
  /**
   * The call was made in a Try conversation, where a person tries an agent under construction.
   * The store marks it from the conversation, so every call there carries the mark.
   */
  preview: boolean;
  customerBillableCost: UsageCostRecord;
  correlationId: string;
  createdAt: ISODateString;
}

/**
 * What an embedding call is for: the chunks of a Knowledge Base at ingestion and re-index, or
 * the query of a search.
 */
export const MODEL_EMBEDDING_PURPOSES = ["knowledge_embedding", "knowledge_query"] as const;
export type ModelEmbeddingPurpose = (typeof MODEL_EMBEDDING_PURPOSES)[number];

/** What a model call that no agent run made was for. */
export type ModelSystemPurpose =
  | "workflow_step"
  | "conversation_title"
  | "guardrail_judge"
  | "document_extraction"
  | "knowledge_field_extraction"
  | ModelEmbeddingPurpose;

/** Knowledge Base ingestion records usage but consumes no chat safeguard or spend budget. */
export const KNOWLEDGE_INGESTION_PURPOSES = [
  "knowledge_embedding",
  "knowledge_field_extraction"
] as const satisfies readonly ModelSystemPurpose[];

/** A model call an agent run made. */
export interface AgentRunModelAttribution {
  kind: "agent_run" | "workflow_step";
  workflowRunId?: string;
  conversationId: ConversationId;
  runId: AgentRunId;
  agentName: string;
  userId?: string;
  workspaceId?: string;
  /** The Operation Run of the tool call that made the model call, where a tool made it. */
  operationRunId?: string;
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

/**
 * Output tokens admission reserves for a call whose request states no maximum. With the size
 * of the request it is what one call holds on the token counters until it ends, so a token
 * limit at or below it admits no call: config validation refuses such a limit.
 */
export const MODEL_CALL_RESERVED_OUTPUT_TOKENS = 16_000;

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
  workflowRunId?: string;
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

/** The most the counters of one scope may hold in a day and in a month. */
export interface ModelUsagePeriodLimits {
  day: ModelUsageCounterLimits;
  month: ModelUsageCounterLimits;
}

/**
 * What a chat call is held against. Knowledge Base ingestion is outside these limits.
 * Every chat call counts on the instance. A call a person made counts
 * on that person (`user`); a call the product made for a person, such as a title or a guardrail
 * check, counts on that person's `system` bucket; a call no person made counts on the shared
 * `system` bucket. The query of a Knowledge Base search is the person's own, as chat is. A call
 * inside a shared workspace also counts on that workspace (`workspace`), whoever made it; a
 * Personal Workspace has no counter of its own (limits spec 3.1).
 */
export interface ModelUsageLimits {
  instance: ModelUsagePeriodLimits;
  /** A person's own bucket and their `system` bucket, each on its own. */
  person: ModelUsagePeriodLimits;
  /** The `system` bucket the calls of no person share. */
  unattended: ModelUsagePeriodLimits;
  /**
   * The spend limit of the person a call is their own: held on their own bucket alone, so a
   * call the product adds for them never uses it up. A call that continues an agent run that
   * already made one is not held against it: the answer that crossed it finishes.
   */
  own?: ModelUsagePeriodLimits;
  /** The spend limit of the shared workspace a call happens in, with the same exception. */
  workspace?: ModelUsagePeriodLimits;
}

export type UsageSpendLimitLevel = (typeof USAGE_SPEND_LIMIT_LEVELS)[number];
/** The levels whose value is one workspace's or one user's. */
export type UsageSpendLimitTarget = Extract<UsageSpendLimitLevel, "workspace" | "user">;

/**
 * Money per UTC day and per UTC month, in micros of the Customer Rate Card's currency. An absent
 * amount is no limit.
 */
export interface UsageSpendAmounts {
  dailyMicros?: number;
  monthlyMicros?: number;
}

/** One limit an admin set (LU-2). Its row replaces nothing but what its level names. */
export interface UsageSpendLimitRecord extends UsageSpendAmounts {
  level: UsageSpendLimitLevel;
  /** The workspace of `workspace`, the user of `user`. Absent on the other levels. */
  targetId?: string;
  updatedAt: ISODateString;
  updatedBy?: string;
}

/**
 * The limits an admin set that one call is held against, as stored: the release config's
 * ceiling is not in it. A level nobody set is absent.
 */
export interface UsageSpendLimitsOfCall {
  instance?: UsageSpendAmounts;
  /**
   * The shared workspace the call happens in, named by the call or else by its conversation,
   * with its own value or else the default. Absent in a Personal Workspace and outside any.
   */
  workspace?: { id: string; limits?: UsageSpendAmounts };
  /** The user's own value or else the default. Absent for a call of no user. */
  user?: UsageSpendAmounts;
}

/** What a counter of the current UTC day or month holds in money, settled and reserved. */
export interface UsageSpendCounter {
  scopeKind: "instance" | "user" | "workspace";
  scopeId: string;
  period: ModelUsageRefusal["period"];
  costMicros: number;
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

export { PERSONAL_AGENTS_KEY, PERSONAL_WORKSPACES_KEY, USAGE_BREAKDOWN_DIMENSIONS, USAGE_ORIGINS };
export type UsageBreakdownDimension = (typeof USAGE_BREAKDOWN_DIMENSIONS)[number];
export type UsageOrigin = (typeof USAGE_ORIGINS)[number];

/** The rows a Breakdown is narrowed to: a value per dimension, the empty string for none. */
export type UsageBreakdownFilter = Partial<Record<UsageBreakdownDimension, string>>;

/** One row of a Breakdown: the value of its dimension, empty where usage has none. */
export interface UsageBreakdownGroup extends ModelUsageTotals {
  key: string;
}

/** What a period held, counted from the records that exist: no click or view is tracked. */
export interface UsageActivityCounts {
  activeUsers: number;
  conversations: number;
  agentRuns: number;
  appActionRuns: number;
  workflowRuns: number;
}

/** What one person's own calls held on their spend counter in one month (LU-3, Users view). */
export interface UserMonthSpend {
  userId: string;
  costMicros: number;
  modelCallCount: number;
  tokens: number;
}

/** What one member used in a shared workspace in one month. */
export interface WorkspaceMemberUsage extends ModelUsageTotals {
  /** Absent for usage whose person is no longer recorded. */
  userId?: string;
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

export interface ModelUsageEventStore extends UsageSpendLimitStore {
  /**
   * Writes the event of a call nobody admitted, such as usage a tool reports, and adds it to
   * the counters of its day and month and to the sums of its day. Without `counted` the
   * counters take its tokens and its settled cost. Ingestion updates sums but no chat counters.
   */
  appendModelUsageEvent(
    input: ModelUsageEventRecordInput,
    counted?: ModelUsageCounted
  ): Promise<ModelUsageEvent>;
  /**
   * Admits a call in one statement: it adds one call and the reservation to the counters of the
   * day and the month of the instance and of the call's scope (`ModelUsageLimits`) when every
   * limit still holds afterwards, and writes the event as `pending` with it. Otherwise it
   * changes nothing and names the limit. The day and the month are those of the database
   * clock. It reads no usage event, except once per period and scope to start a counter that
   * does not exist yet from the events the period already has. Knowledge Base ingestion writes
   * its event without checking or reserving chat counters.
   */
  admitModelUsageEvent(input: {
    event: ModelUsageEventRecordInput;
    reservation: ModelUsageCounted;
    limits: ModelUsageLimits;
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
  /** Settled spend for chat budgets, excluding Knowledge Base ingestion, from daily rollups. */
  summarizeModelUsageBudget(input: {
    clientInstanceId: ClientInstanceId;
    todayStart: ISODateString;
    currentMonthStart: ISODateString;
  }): Promise<{ dailySpentMicros: number; monthlySpentMicros: number }>;
  /** The sums of the days from `from` on. Reads no usage event. */
  summarizeRecentModelUsage(input: {
    clientInstanceId: ClientInstanceId;
    from: ISODateString;
  }): Promise<RecentModelUsage>;
  /**
   * The daily sums of the UTC days from `from` up to `to` (`YYYY-MM-DD`, `to` excluded), narrowed
   * by `filter` and grouped by one dimension or by day. Reads no usage event.
   */
  summarizeModelUsageBreakdown(input: {
    clientInstanceId: ClientInstanceId;
    from: string;
    to: string;
    /** `day` groups by UTC day, `all` sums the whole period into one row. */
    groupBy: UsageBreakdownDimension | "day" | "all";
    filter?: UsageBreakdownFilter;
  }): Promise<UsageBreakdownGroup[]>;
  /**
   * What each person used in one shared workspace from `from` up to `to`, summed from its usage
   * events: one workspace and a bounded period, by `model_usage_events_workspace_created_idx`.
   */
  summarizeWorkspaceMemberUsage(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    from: ISODateString;
    to: ISODateString;
  }): Promise<WorkspaceMemberUsage[]>;
  /**
   * The people active and the conversations, Agent Runs, App action runs and Workflow Runs
   * started from `from` up to `to`; of one shared workspace, from its usage events and its
   * Operation Runs, where one is named.
   */
  countUsageActivity(input: {
    clientInstanceId: ClientInstanceId;
    from: ISODateString;
    to: ISODateString;
    collaborationWorkspaceId?: CollaborationWorkspaceId;
  }): Promise<UsageActivityCounts>;
  /** What each person's own calls hold on their spend counter of one UTC month (`YYYY-MM`). */
  listUserMonthSpend(input: {
    clientInstanceId: ClientInstanceId;
    month: string;
  }): Promise<UserMonthSpend[]>;
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

/** The spend limits an admin sets (LU-2) and what their counters hold. */
export interface UsageSpendLimitStore {
  /**
   * The limits one call is held against: the instance's, the shared workspace's (named, or
   * that of the conversation) and the user's, each level's own value before its default.
   */
  readSpendLimits(input: {
    clientInstanceId: ClientInstanceId;
    userId?: string;
    workspaceId?: string;
    conversationId?: string;
  }): Promise<UsageSpendLimitsOfCall>;
  /** Every limit set on the instance. */
  listSpendLimits(input: { clientInstanceId: ClientInstanceId }): Promise<UsageSpendLimitRecord[]>;
  /**
   * Sets the limit of one level, or removes it with `null`: the default applies again to one
   * workspace or user, no limit to a default, the release config's ceiling to the instance.
   * Resolves with what was set before.
   */
  setSpendLimit(input: {
    clientInstanceId: ClientInstanceId;
    level: UsageSpendLimitLevel;
    targetId?: string;
    limits: UsageSpendAmounts | null;
    updatedBy?: string;
  }): Promise<{ previous?: UsageSpendAmounts }>;
  /**
   * What the counters of the current UTC day and month hold in money: the instance's, and those
   * of the users and shared workspaces named, or of every user and workspace with `all`.
   */
  readSpendCounters(input: {
    clientInstanceId: ClientInstanceId;
    users?: readonly string[];
    workspaces?: readonly string[];
    all?: boolean;
  }): Promise<UsageSpendCounter[]>;
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
