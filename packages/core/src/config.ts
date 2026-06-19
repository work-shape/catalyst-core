import type { LocalizationConfig, LocalizedStringConfig } from "./localization";

export interface AgentInitialPromptConfig {
  title: LocalizedStringConfig;
  prompt: LocalizedStringConfig;
}

export interface DeterministicModelProviderConfig {
  id: string;
  type: "deterministic";
  model: string;
}

export interface OpenAiCompatibleModelProviderConfig {
  id: string;
  type: "openai-compatible";
  api?: OpenAiCompatibleModelProviderApiConfig;
  model: string;
  baseUrl: string;
  apiKeyEnvName: string;
  organizationEnvName?: string;
  reasoningEffort?: ReasoningEffortConfig;
}

export type ModelProviderConfig =
  | DeterministicModelProviderConfig
  | OpenAiCompatibleModelProviderConfig;

export type OpenAiCompatibleModelProviderApiConfig = "chat_completions" | "responses";
export type ReasoningEffortConfig = "none" | "low" | "medium" | "high" | "xhigh";

export interface AgentConfig {
  name: string;
  displayName: LocalizedStringConfig;
  welcomeMessage?: LocalizedStringConfig;
  instructions: string;
  modelProviderId?: string;
  maxSteps?: number;
  toolNames: string[];
  skillNames: string[];
  initialPrompts: AgentInitialPromptConfig[];
}

export interface SkillConfig {
  name: string;
  title: string;
  description: string;
  content: string;
}

export type { LocalizationConfig, LocalizedStringConfig };

export interface UsageBudgetConfig {
  monthlySpendLimit?: number;
  costSafetyMultiplier: number;
}

export interface UsageSafeguardsConfig {
  modelCallsPerDay?: number;
  tokensPerDay?: number;
  tokensPerMonth?: number;
}

export interface UsagePricingModelConfig {
  providerId: string;
  model: string;
  inputPricePerMillionTokens: number;
  outputPricePerMillionTokens: number;
}

export interface UsagePricingConfig {
  currency: string;
  models: UsagePricingModelConfig[];
}

export interface ModelContextToolOutputBoundsConfig {
  maxTokens: number;
  maxBytes?: number;
}

export interface AgentRuntimeConfig {
  maxSteps: number;
  repeatedToolCallLimit: number;
}

export interface ModelContextConfig {
  toolOutput: ModelContextToolOutputBoundsConfig;
}

export interface PostgresDataSourceConfig {
  kind: "postgres";
  connectionRef: string;
  description: string;
  sql: {
    dialect: "postgres";
    access: "read_only";
    statementTimeoutMs: number;
    maxRows: number;
    allowedSchemas: string[];
    schemaDescription?: string;
  };
  tools?: {
    query?: {
      enabled: boolean;
      name?: string;
    };
    renderView?: {
      enabled: boolean;
      name?: string;
      modelVisibleOutput: "zero_data_ack";
    };
  };
}

export type DataSourceConfig = PostgresDataSourceConfig;

export type CapabilityConfigMap = Record<string, unknown>;
