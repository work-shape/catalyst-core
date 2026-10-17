import {
  AGENT_EDITABLE_FIELDS,
  AGENT_STARTERS_MAX,
  MODEL_PROVIDER_AUTH_MODES,
  MODEL_USAGE_TIERS,
  OPENAI_COMPATIBLE_APIS,
  REASONING_EFFORTS,
  SKILL_ORIGINS,
  SKILL_RESOURCE_MEDIA_TYPES,
  SKILL_STARTERS_MAX,
  SKILL_SUMMARY_MAX_LENGTH,
  formatSkillMarkdown,
  skillResourceMediaTypeForPath,
  type AgentConfig,
  type AgentInitialPromptConfig,
  type ReasoningEffortConfig,
  type SkillConfig,
  type SkillOrigin,
  type SkillResourceConfig,
  type SkillResourceMediaType,
  type SkillStarterConfig
} from "@work-shape/catalyst-asset-schemas";
import type { LocalizationConfig, LocalizedStringConfig } from "./localization";
import type { ProviderRegion } from "./providers";

export type ModelProviderAuthModeConfig = (typeof MODEL_PROVIDER_AUTH_MODES)[number];

/**
 * What the product reads of one entry under `infrastructure.models`: its name, the registered
 * provider type and the fields of the models port. Connection settings and secret names belong
 * to the adapter and are not here.
 */
export interface ModelProviderConfig {
  /** The entry's name under `infrastructure.models`. */
  id: string;
  /** The registered provider type. Only its adapter knows what the type means. */
  type: string;
  model: string;
  /** Present when the provider sends data outside the instance. */
  region?: ProviderRegion;
  api?: OpenAiCompatibleModelProviderApiConfig;
  reasoningEffort?: ReasoningEffortConfig;
  contextManagement?: OpenAiCompatibleContextManagementConfig;
}

export type OpenAiCompatibleModelProviderApiConfig = (typeof OPENAI_COMPATIBLE_APIS)[number];
export interface OpenAiCompatibleContextManagementConfig {
  compaction?: {
    compactThresholdTokens: number;
  };
}

export { AGENT_EDITABLE_FIELDS } from "@work-shape/catalyst-asset-schemas";
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

/**
 * What a model binding is for. A `chat` binding answers agent runs and the product's own calls;
 * an `embedding` binding turns text into vectors for Knowledge Bases and answers nothing else.
 */
export const MODEL_BINDING_KINDS = ["chat", "embedding"] as const;
export type ModelBindingKind = (typeof MODEL_BINDING_KINDS)[number];

/** The most dimensions an embedding binding may ask for: what pgvector's `vector` type stores. */
export const MODEL_EMBEDDING_MAX_DIMENSIONS = 16_000;

export interface ModelBindingConfig {
  id: string;
  providerId: string;
  model?: string;
  /** Absent is `chat`. */
  kind?: ModelBindingKind;
  /** The length of every vector an `embedding` binding returns. Only an embedding binding has it. */
  dimensions?: number;
  reasoningEffort?: ReasoningEffortConfig;
  agentSelectable?: boolean;
  /** Accepted for compatibility; no effect. Each agent lists the models its users may pick. */
  userSelectable?: boolean;
  supportsFastMode?: boolean;
  /** Shown on the model card in the chat's model picker. */
  description?: LocalizedStringConfig;
  /**
   * The name people read for this model. Unset shows the model id tidied up, which suits a
   * vendor's own model name and not a deployment name an operator chose.
   */
  label?: string;
  /** Who makes the model, for its icon. Derived from the model id when unset. */
  vendor?: string;
  /** Overrides the usage tier derived from the Customer Rate Card. */
  usageTier?: ModelUsageTier;
  /**
   * Reasoning efforts a user may pick for this model in the chat. Unset offers low, medium and
   * high; an empty list leaves the effort to the agent's model settings.
   */
  userSelectableReasoningEfforts?: ReasoningEffortConfig[];
}

export { MODEL_USAGE_TIERS } from "@work-shape/catalyst-asset-schemas";
export type ModelUsageTier = (typeof MODEL_USAGE_TIERS)[number];

/**
 * Upper bounds of the first five usage tiers, as a blended price per million tokens in the
 * rate card's currency. The scale is logarithmic: each tier ends at twice the price of the one
 * before. It is fixed and the same for every instance, so adding or removing a model never
 * moves another model into a different tier.
 */
export const MODEL_USAGE_TIER_BOUNDS = [1.25, 2.5, 5, 10, 20] as const;

/**
 * How much of a usage limit a model consumes relative to others, from its rate card prices.
 * Runs read roughly three input tokens per output token, so the blend weights them 3:1. A price
 * on a bound belongs to the tier above it.
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
  return MODEL_USAGE_TIERS[tier === -1 ? MODEL_USAGE_TIERS.length - 1 : tier] ?? "very_high";
}

/** Offered, where the model takes them, when a binding does not say which efforts users may pick. */
const DEFAULT_USER_SELECTABLE_REASONING_EFFORTS: readonly ReasoningEffortConfig[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
/** What the picker shows for a model with no configured effort: the provider's own default. */
const ASSUMED_REASONING_EFFORT: ReasoningEffortConfig = "medium";

/**
 * The reasoning efforts a user may pick for a model, weakest first, and the one a run uses
 * when they pick none. A binding offers the default efforts its model takes unless it lists its
 * own; an empty list leaves no choice. The default is always among the efforts offered, so the
 * user can return to it. A model without a binding, or one that takes no reasoning effort,
 * offers no choice. `modelReasoningEfforts` is what the model's adapter declares.
 */
export function reasoningEffortChoiceForBinding(
  binding: Pick<ModelBindingConfig, "userSelectableReasoningEfforts"> | undefined,
  modelReasoningEfforts: readonly ReasoningEffortConfig[],
  configuredEffort: ReasoningEffortConfig | undefined
): { defaultEffort: ReasoningEffortConfig | undefined; selectable: ReasoningEffortConfig[] } {
  const offered = new Set(
    binding?.userSelectableReasoningEfforts ??
      (binding
        ? DEFAULT_USER_SELECTABLE_REASONING_EFFORTS.filter((effort) =>
            modelReasoningEfforts.includes(effort)
          )
        : [])
  );
  if (offered.size === 0) {
    return { defaultEffort: configuredEffort, selectable: [] };
  }
  const defaultEffort = configuredEffort ?? ASSUMED_REASONING_EFFORT;
  return {
    defaultEffort,
    selectable: REASONING_EFFORTS.filter(
      (effort) => offered.has(effort) || effort === defaultEffort
    )
  };
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
  return authorReasoningEffort(agent, binding.id) ?? binding.reasoningEffort;
}

/**
 * The reasoning effort the agent's author set for one of its models: `reasoningEffort` for its
 * own, `modelReasoningEfforts` for one listed for users. Without one the effort is left open.
 */
export function authorReasoningEffort(
  agent: Pick<AgentConfig, "modelBindingId" | "reasoningEffort" | "modelReasoningEfforts">,
  bindingId: string | undefined
): ReasoningEffortConfig | undefined {
  return bindingId === agent.modelBindingId
    ? agent.reasoningEffort
    : bindingId === undefined
      ? undefined
      : agent.modelReasoningEfforts?.[bindingId];
}

/**
 * The efforts a person is offered for one of an agent's models (UX audit ruling 4). Whoever may
 * write the agent is offered what the model allows. Every other person is offered no other
 * effort where the author set one: the efforts a model allows are no choice by themselves.
 */
export function reasoningEffortsOffered(
  allowed: readonly ReasoningEffortConfig[],
  authorEffort: ReasoningEffortConfig | undefined,
  mayWriteAgent: boolean
): ReasoningEffortConfig[] {
  return mayWriteAgent || authorEffort === undefined ? [...allowed] : [];
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

export interface AgentSkillChangesPolicy {
  enabled: boolean;
  allowSkillCreation: boolean;
}

export {
  AGENT_STARTERS_MAX,
  REASONING_EFFORTS,
  SKILL_ORIGINS,
  SKILL_RESOURCE_MEDIA_TYPES,
  SKILL_STARTERS_MAX,
  SKILL_SUMMARY_MAX_LENGTH,
  formatSkillMarkdown,
  skillResourceMediaTypeForPath,
  type AgentConfig,
  type AgentInitialPromptConfig,
  type ReasoningEffortConfig,
  type SkillConfig,
  type SkillOrigin,
  type SkillResourceConfig,
  type SkillResourceMediaType,
  type SkillStarterConfig
};

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
  /** How long a run, and a call, waits for the source of an agent's data tools. */
  dataToolDescribeTimeoutMs: number;
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

/** The instance switch for web search. Whether a model can search is its adapter's to declare. */
export interface WebAccessSearchConfig {
  enabled: boolean;
}

export interface WebAccessConfig {
  enabled: boolean;
  search: WebAccessSearchConfig;
  fetch: WebAccessFetchConfig;
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
