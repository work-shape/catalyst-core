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
  contextManagement?: OpenAiCompatibleContextManagementConfig;
  compliance?: ModelProviderComplianceConfig;
}

export type ModelProviderConfig =
  DeterministicModelProviderConfig | OpenAiCompatibleModelProviderConfig;

export type OpenAiCompatibleModelProviderApiConfig = "chat_completions" | "responses";
export interface OpenAiCompatibleContextManagementConfig {
  compaction?: {
    compactThresholdTokens: number;
  };
}
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffortConfig = (typeof REASONING_EFFORTS)[number];

export const AGENT_EDITABLE_FIELDS = [
  "displayName",
  "description",
  "welcomeMessage",
  "welcomeSubtitle",
  "instructions",
  "modelBindingId",
  "reasoningEffort",
  "maxSteps",
  "toolNames",
  "skillNames",
  "initialPrompts"
] as const;
export type AgentEditableField = (typeof AGENT_EDITABLE_FIELDS)[number];

/** Governed by the `agent_models.manage` permission instead of `editableAgentFields`. */
export const AGENT_MODEL_SETTING_FIELDS = [
  "modelBindingId",
  "reasoningEffort",
  "fastMode",
  "userSelectableModelBindingIds",
  "modelReasoningEfforts"
] as const;
export type AgentModelSettingField = (typeof AGENT_MODEL_SETTING_FIELDS)[number];

export interface ModelBindingConfig {
  id: string;
  providerId: string;
  model?: string;
  reasoningEffort?: ReasoningEffortConfig;
  agentSelectable?: boolean;
  /** Accepted for compatibility; no effect. Each agent lists the models its users may pick. */
  userSelectable?: boolean;
  supportsFastMode?: boolean;
  /** Shown on the model card in the chat's model picker. */
  description?: LocalizedStringConfig;
  /** Who makes the model, for its icon. Derived from the model id when unset. */
  vendor?: string;
  /** Overrides the usage tier derived from the Customer Rate Card. */
  usageTier?: ModelUsageTier;
  /**
   * Reasoning efforts a user may pick for this model in the chat. Empty or unset leaves the
   * effort to the agent's model settings.
   */
  userSelectableReasoningEfforts?: ReasoningEffortConfig[];
}

export const MODEL_USAGE_TIERS = ["low", "moderate", "high", "very_high"] as const;
export type ModelUsageTier = (typeof MODEL_USAGE_TIERS)[number];

/**
 * Upper bounds of the first three usage tiers, as a blended price per million tokens in the
 * rate card's currency. The scale is fixed so adding or removing a model never moves another
 * model into a different tier.
 */
const MODEL_USAGE_TIER_BOUNDS = [1, 5, 15] as const;

/**
 * How much of a usage limit a model consumes relative to others, from its rate card prices.
 * Runs read roughly three input tokens per output token, so the blend weights them 3:1.
 */
export function modelUsageTierFromRates(
  rates: Pick<
    UsageRateCardTokenRatesConfig,
    "uncachedInputPricePerMillionTokens" | "outputPricePerMillionTokens"
  >
): ModelUsageTier {
  const blended =
    (3 * rates.uncachedInputPricePerMillionTokens + rates.outputPricePerMillionTokens) / 4;
  const tier = MODEL_USAGE_TIER_BOUNDS.findIndex((bound) => blended < bound);
  return MODEL_USAGE_TIERS[tier === -1 ? MODEL_USAGE_TIERS.length - 1 : tier]!;
}

/**
 * The efforts a user may pick for a binding, weakest first; none when the binding offers no
 * choice. The effort a run would use anyway is always among them, so the user can return to
 * it without release config having to list it.
 */
export function userSelectableReasoningEffortsForBinding(
  binding: Pick<ModelBindingConfig, "userSelectableReasoningEfforts"> | undefined,
  defaultEffort?: ReasoningEffortConfig
): ReasoningEffortConfig[] {
  const offered = new Set(binding?.userSelectableReasoningEfforts ?? []);
  if (offered.size === 0) {
    return [];
  }
  return REASONING_EFFORTS.filter((effort) => offered.has(effort) || effort === defaultEffort);
}

/**
 * The effort a run uses when the user picks none. The agent's own effort belongs to its own
 * model; a model the user picked instead uses the effort configured for that binding on this
 * agent, then the binding's default.
 */
export function defaultReasoningEffortForAgentBinding(
  agent: Pick<AgentConfig, "modelBindingId" | "reasoningEffort" | "modelReasoningEfforts">,
  binding: Pick<ModelBindingConfig, "id" | "reasoningEffort">
): ReasoningEffortConfig | undefined {
  return (
    (binding.id === agent.modelBindingId
      ? agent.reasoningEffort
      : agent.modelReasoningEfforts?.[binding.id]) ?? binding.reasoningEffort
  );
}

export interface AgentConfig {
  name: string;
  displayName: LocalizedStringConfig;
  description?: LocalizedStringConfig;
  welcomeMessage?: LocalizedStringConfig;
  welcomeSubtitle?: LocalizedStringConfig;
  instructions: string;
  modelProviderId?: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffortConfig;
  fastMode?: boolean;
  /** Bindings users may pick for this agent in the chat, besides its own `modelBindingId`. */
  userSelectableModelBindingIds?: string[];
  /**
   * Reasoning effort per user-selectable binding. `reasoningEffort` stays the effort of the
   * agent's own model and is not applied to a model a user picked instead.
   */
  modelReasoningEfforts?: Record<string, ReasoningEffortConfig>;
  maxSteps?: number;
  toolNames: string[];
  skillNames: string[];
  initialPrompts: AgentInitialPromptConfig[];
}

/**
 * The bindings a user may pick for this agent besides its own: the listed ids whose binding
 * still exists and is one agents may use. Stale ids are ignored rather than failing the agent.
 */
export function userSelectableModelBindingsForAgent<Binding extends ModelBindingConfig>(
  agent: Pick<AgentConfig, "modelBindingId" | "userSelectableModelBindingIds">,
  modelBindings: readonly Binding[]
): Binding[] {
  const listed = new Set(agent.userSelectableModelBindingIds ?? []);
  return modelBindings.filter(
    (binding) =>
      binding.agentSelectable !== false &&
      binding.id !== agent.modelBindingId &&
      listed.has(binding.id)
  );
}

/** A user may request the agent's own binding or one of its user-selectable bindings. */
export function isModelBindingUserSelectableForAgent(
  agent: Pick<AgentConfig, "modelBindingId" | "userSelectableModelBindingIds">,
  modelBindings: readonly ModelBindingConfig[],
  modelBindingId: string
): boolean {
  return (
    modelBindingId === agent.modelBindingId ||
    userSelectableModelBindingsForAgent(agent, modelBindings).some(
      (binding) => binding.id === modelBindingId
    )
  );
}

export interface ApprovalCheckConfig {
  id: string;
  appliesTo: string;
  modelBindingId: string;
  instruction: string;
  onFail: "warn" | "block";
}

export interface AgentSkillChangesPolicy {
  enabled: boolean;
  allowSkillCreation: boolean;
}

export interface SkillConfig {
  name: string;
  title: string;
  description: string;
  content: string;
  resources?: SkillResourceConfig[];
}

export const SKILL_RESOURCE_MEDIA_TYPES = [
  "text/markdown",
  "text/plain",
  "application/json",
  "application/yaml"
] as const;

export type SkillResourceMediaType = (typeof SKILL_RESOURCE_MEDIA_TYPES)[number];

export interface SkillResourceConfig {
  path: string;
  mediaType: SkillResourceMediaType;
  content: string;
}

export type { LocalizationConfig, LocalizedStringConfig };

export interface UsageBudgetConfig {
  dailySpendLimit?: number;
  monthlySpendLimit?: number;
  costSafetyMultiplier?: number;
}

export interface UsageSafeguardsConfig {
  modelCallsPerDay?: number;
  tokensPerDay?: number;
  tokensPerMonth?: number;
}

export interface UsageRateCardTokenRatesConfig {
  uncachedInputPricePerMillionTokens: number;
  cachedInputPricePerMillionTokens: number;
  outputPricePerMillionTokens: number;
}

export interface UsageRateCardModelConfig extends UsageRateCardTokenRatesConfig {
  providerId: string;
  model: string;
  /** Rates for fast-mode model calls. Required for every binding that supports fast mode. */
  fast?: UsageRateCardTokenRatesConfig;
}

export interface UsageRateCardWebSearchConfig {
  providerId: string;
  model?: string;
  pricePerCall: number;
}

export interface UsageRateCardConfig {
  id: string;
  version: string;
  currency: string;
  models: UsageRateCardModelConfig[];
  webSearch?: UsageRateCardWebSearchConfig[];
}

export interface UsageCostConfig {
  customer?: UsageRateCardConfig;
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
  hydratedWorkspaceIdleTtlMs: number;
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
