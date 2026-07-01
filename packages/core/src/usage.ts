import type { AgentRunId, ClientInstanceId, ConversationId, ModelUsageEventId } from "./ids";
import type { ISODateString } from "./time";

export type ModelUsageSource = "provider_reported" | "not_reported" | "estimated";

export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: ModelUsageSource;
}

export interface ModelUsageEvent extends ModelTokenUsage {
  id: ModelUsageEventId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  agentRunId: AgentRunId;
  agentName: string;
  providerId: string;
  model: string;
  webSearchCallCount: number;
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

export interface ModelUsageWindowSummary {
  start?: ISODateString;
  end?: ISODateString;
  modelCallCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  webSearchCallCount: number;
}

export interface ModelUsageWindowBounds {
  todayStart: ISODateString;
  currentMonthStart: ISODateString;
}

export interface ModelUsageEventStore {
  appendModelUsageEvent(input: ModelUsageEventInput): Promise<ModelUsageEvent>;
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
