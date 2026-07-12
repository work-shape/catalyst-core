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

export type ModelProviderAuthModeConfig = "bearer" | "api-key";
export type ModelProviderResidencyConfig = "global" | "eu" | "unknown";

export interface ModelProviderComplianceConfig {
  residency?: ModelProviderResidencyConfig;
  productionApproved?: boolean;
  notes?: string;
}

export interface OpenAiCompatibleModelProviderConfig {
  id: string;
  type: "openai-compatible";
  api?: OpenAiCompatibleModelProviderApiConfig;
  model: string;
  baseUrl: string;
  apiKeyEnvName: string;
  authMode?: ModelProviderAuthModeConfig;
  organizationEnvName?: string;
  reasoningEffort?: ReasoningEffortConfig;
  compliance?: ModelProviderComplianceConfig;
}

export type ModelProviderConfig =
  | DeterministicModelProviderConfig
  | OpenAiCompatibleModelProviderConfig;

export type OpenAiCompatibleModelProviderApiConfig = "chat_completions" | "responses";
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffortConfig = (typeof REASONING_EFFORTS)[number];

export const AGENT_EDITABLE_FIELDS = [
  "displayName",
  "welcomeMessage",
  "welcomeSubtitle",
  "instructions",
  "modelProviderId",
  "modelBindingId",
  "reasoningEffort",
  "maxSteps",
  "toolNames",
  "skillNames",
  "initialPrompts"
] as const;
export type AgentEditableField = (typeof AGENT_EDITABLE_FIELDS)[number];

export interface ModelBindingConfig {
  id: string;
  providerId: string;
  model?: string;
  reasoningEffort?: ReasoningEffortConfig;
  agentSelectable?: boolean;
}

export interface AgentConfig {
  name: string;
  displayName: LocalizedStringConfig;
  welcomeMessage?: LocalizedStringConfig;
  welcomeSubtitle?: LocalizedStringConfig;
  instructions: string;
  modelProviderId?: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffortConfig;
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
  dailySpendLimit?: number;
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

export interface UsagePricingWebSearchConfig {
  providerId: string;
  model?: string;
  pricePerCall: number;
}

export interface UsagePricingConfig {
  currency: string;
  models: UsagePricingModelConfig[];
  webSearch?: UsagePricingWebSearchConfig[];
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

export interface WebAccessFetchConfig {
  enabled: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  maxTextCharacters: number;
  maxRedirects: number;
}

export type WebAccessSearchModeConfig = "native_or_managed" | "native_only" | "managed_only";

export interface WebAccessSearchConfig {
  enabled: boolean;
  mode: WebAccessSearchModeConfig;
  managedProvider?: string;
}

export interface WebAccessConfig {
  enabled: boolean;
  search: WebAccessSearchConfig;
  fetch: WebAccessFetchConfig;
}

export type ExecutionWorkspaceRunnerModeConfig = "local" | "docker";
export type ExecutionWorkspaceNetworkModeConfig = "none";

export interface ExecutionWorkspaceRunnerConfig {
  mode: ExecutionWorkspaceRunnerModeConfig;
  image: string;
  networkMode: ExecutionWorkspaceNetworkModeConfig;
  readOnlyRootFilesystem: boolean;
  cpuCount: number;
  memoryBytes: number;
  pidsLimit: number;
}

export interface ExecutionWorkspaceCommandConfig {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxWorkspaceBytes: number;
  perConversationActiveCommands: number;
  perUserActiveCommands: number;
  globalActiveCommands: number;
}

export interface ExecutionWorkspaceWorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  cancellationPollIntervalMs: number;
  staleRecoveryIntervalMs: number;
  staleRecoveryLimit: number;
}

export interface ExecutionWorkspaceCleanupConfig {
  deletedWorkspaceCleanupIntervalMs: number;
  deletedWorkspaceCleanupBatchSize: number;
  tempStateCleanupIntervalMs: number;
  orphanedTempStateMaxAgeMs: number;
}

export interface ExecutionWorkspacesConfig {
  enabled: boolean;
  runner: ExecutionWorkspaceRunnerConfig;
  command: ExecutionWorkspaceCommandConfig;
  worker: ExecutionWorkspaceWorkerConfig;
  cleanup: ExecutionWorkspaceCleanupConfig;
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
