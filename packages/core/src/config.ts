import type { LocalizationConfig, LocalizedStringConfig } from "./localization";
import type { DocumentFileFormat } from "./files";

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
  initialPrompts: AgentInitialPromptConfig[];
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
    renderView?: {
      enabled: boolean;
      name?: string;
      modelVisibleOutput: "zero_data_ack";
    };
  };
}

export type DataSourceConfig = PostgresDataSourceConfig;

export interface DocumentPreprocessingConfig {
  enabled: boolean;
  supportedFormats: DocumentFileFormat[];
  maxFileBytes: number;
  maxExtractedTextBytes: number;
  timeoutMs: number;
  perConversationConcurrency: number;
  globalConcurrency: number;
  converterCommand: string;
  converterArgs: string[];
  preprocessingVersion: string;
}

export interface DocumentObjectStorageConfig {
  kind: "s3";
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyIdEnvName?: string;
  secretAccessKeyEnvName?: string;
}

export interface DocumentsConfig {
  preprocessing: DocumentPreprocessingConfig;
  objectStorage: DocumentObjectStorageConfig;
}
