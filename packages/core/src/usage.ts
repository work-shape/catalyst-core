import type { AgentRunId, ClientInstanceId, ConversationId, ModelUsageEventId } from "./ids";
import type { ISODateString } from "./time";

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
  | "token_usage"
  | "cached_input_tokens"
  | "model_rate"
  | "web_search_rate";

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
  conversationId: ConversationId;
  agentRunId: AgentRunId;
  agentName: string;
  providerId: string;
  model: string;
  webSearchCallCount: number;
  customerBillableCost: UsageCostRecord;
  correlationId: string;
  createdAt: ISODateString;
}

export interface ModelUsageEventInput extends ModelTokenUsage {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  agentRunId: AgentRunId;
  agentName: string;
  providerId: string;
  model: string;
  webSearchCallCount?: number;
  correlationId: string;
}

export interface ModelUsageEventRecordInput extends ModelUsageEventInput {
  webSearchCallCount: number;
  customerBillableCost: UsageCostRecord;
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
