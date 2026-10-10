import type { StorePage } from "./paging";
import type { AgentRunId, ClientInstanceId, ConversationId, ModelUsageEventId } from "./ids";
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
  /** The agent of the run, or for a call the product made for itself what it was for. */
  agentName: string;
  providerId: string;
  model: string;
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

export interface ModelUsageEventInput extends ModelTokenUsage {
  clientInstanceId: ClientInstanceId;
  attribution: ModelAttribution;
  providerId: string;
  model: string;
  /** Where the provider entry processes data. Carried for the usage columns LU-1 adds. */
  region?: ProviderRegion;
  webSearchCallCount?: number;
  fastMode?: boolean;
  providerServiceTier?: string;
  correlationId: string;
}

export interface ModelUsageEventRecordInput extends ModelTokenUsage {
  clientInstanceId: ClientInstanceId;
  conversationId?: ConversationId;
  agentRunId?: AgentRunId;
  agentName: string;
  providerId: string;
  model: string;
  webSearchCallCount: number;
  fastMode: boolean;
  providerServiceTier?: string;
  customerBillableCost: UsageCostRecord;
  correlationId: string;
}

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

export interface ModelUsageEventStore {
  appendModelUsageEvent(input: ModelUsageEventRecordInput): Promise<ModelUsageEvent>;
  summarizeModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: ISODateString;
    end?: ISODateString;
  }): Promise<ModelUsageWindowSummary>;
  listModelUsageEvents(input: {
    clientInstanceId: ClientInstanceId;
    start?: ISODateString;
    end?: ISODateString;
    limit?: number;
    page?: StorePage;
  }): Promise<ModelUsageEvent[]>;
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
