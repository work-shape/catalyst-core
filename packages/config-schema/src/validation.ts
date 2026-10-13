import { AppError, MODEL_CALL_RESERVED_OUTPUT_TOKENS } from "@vivd-catalyst/core";
import { clientInstanceConfigSchema, type AgentConfig, type ClientInstanceConfig } from "./schemas";
import { isPasswordMailEnabled } from "./branding";
import { resolveModuleSwitches } from "./module-normalization";
import { findDuplicates } from "./reference-validation";
import { withoutRemovedWorkspaceSwitch } from "./removed-workspace-switch";
import { getModelProviderConfigs } from "./infrastructure";
import { refuseMovedInfrastructureKeys } from "./moved-infrastructure-keys";
import { withApprovalChecksAsGuardrails } from "./approval-checks-transition";
import { invalidConfigError } from "./config-errors";
import {
  getModelSelectionForAgent,
  getModelSelectionForConversationTitles,
  resolveModelBinding
} from "./selectors";

export { invalidConfigError };

export function parseClientInstanceConfig(input: unknown): ClientInstanceConfig {
  refuseMovedInfrastructureKeys(input);
  const parsed = clientInstanceConfigSchema.safeParse(
    withoutRemovedUiSwitch(withApprovalChecksAsGuardrails(input))
  );
  if (!parsed.success) {
    throw invalidConfigError("Client instance config is invalid", parsed.error.issues);
  }

  assertProductionSafeAuthConfig(parsed.data);
  assertCaptureMailIsDevelopmentOnly(parsed.data);
  assertExecutionWorkspaceInfrastructure(parsed.data);
  assertModuleSwitches(parsed.data);
  assertConfigReferences(parsed.data);
  assertEmbeddingBindings(parsed.data);
  assertTokenSafeguardsAdmitACall(parsed.data);
  assertFastModePricingCoverage(parsed.data);
  assertSpendBudgetPricingCoverage(parsed.data, []);
  return parsed.data;
}

function withoutRemovedUiSwitch(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("ui" in input)) {
    return input;
  }
  return { ...input, ui: withoutRemovedWorkspaceSwitch(input.ui) };
}

function assertProductionSafeAuthConfig(config: ClientInstanceConfig): void {
  if (config.clientInstance.environment !== "production") {
    return;
  }

  if (config.auth.development?.enabled) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Development auth must not be enabled in production config"
    );
  }

  const seedUserWithDevelopmentPassword = config.auth.standalone?.seedUsers.find(
    (seedUser) => seedUser.developmentPassword
  );
  if (!seedUserWithDevelopmentPassword) {
    return;
  }

  throw new AppError(
    "VALIDATION_FAILED",
    `Standalone auth seed user '${seedUserWithDevelopmentPassword.email}' uses developmentPassword in production config`
  );
}

function assertCaptureMailIsDevelopmentOnly(config: ClientInstanceConfig): void {
  if (
    config.infrastructure.mail?.provider !== "capture" ||
    config.clientInstance.environment === "development"
  ) {
    return;
  }

  // Captured mails, including password setup links, are listed by an unauthenticated route.
  throw new AppError(
    "VALIDATION_FAILED",
    "The capture mail provider is only allowed for development client instances"
  );
}

function assertExecutionWorkspaceInfrastructure(config: ClientInstanceConfig): void {
  if (!config.executionWorkspaces.enabled) {
    return;
  }
  const { sandbox, objectStorage } = config.infrastructure;
  if (!objectStorage.workspaces) {
    throw new AppError(
      "VALIDATION_FAILED",
      "'infrastructure.objectStorage.workspaces' is required when execution workspaces are enabled; the variables EXECUTION_WORKSPACE_OBJECT_ROOT and ARTIFACT_PREVIEW_OBJECT_ROOT are no longer read"
    );
  }
  if (!sandbox) {
    throw new AppError(
      "VALIDATION_FAILED",
      "'infrastructure.sandbox' is required when execution workspaces are enabled"
    );
  }
  if (sandbox.provider !== "local" || config.clientInstance.environment === "development") {
    return;
  }

  // The local sandbox executes in host temp directories for development and unit tests.
  // Customer-facing enabled workspaces need the Docker sandbox's mounted /workspace contract.
  throw new AppError(
    "VALIDATION_FAILED",
    "'infrastructure.sandbox.provider': the local sandbox is only allowed for development client instances"
  );
}

/**
 * The switches agree with their legacy keys, and invitations are on only where one can be sent:
 * an invitation is an emailed link to set a password, so the module needs both.
 */
function assertModuleSwitches(config: ClientInstanceConfig): void {
  if (!resolveModuleSwitches(config).userInvitations?.enabled || isPasswordMailEnabled(config)) {
    return;
  }
  throw new AppError(
    "VALIDATION_FAILED",
    "Module 'userInvitations' is enabled but invitations cannot be sent: it needs a mail sender under 'infrastructure.mail' and 'auth.standalone.enabled'"
  );
}

function assertConfigReferences(config: ClientInstanceConfig): void {
  const providerIds = new Set(getModelProviderConfigs(config).map((provider) => provider.id));
  const duplicateModelBindingIds = findDuplicates(
    config.modelBindings.map((binding) => binding.id)
  );
  if (duplicateModelBindingIds.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Duplicate model binding definitions: ${duplicateModelBindingIds.join(", ")}`
    );
  }

  const modelBindingIds = new Set(config.modelBindings.map((binding) => binding.id));
  for (const [name, guardrail] of Object.entries(config.guardrails)) {
    if (!modelBindingIds.has(guardrail.check.modelBindingId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Guardrail '${name}' references missing model binding '${guardrail.check.modelBindingId}'`
      );
    }
  }
  for (const binding of config.modelBindings) {
    if (!providerIds.has(binding.providerId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Model binding '${binding.id}' references missing model provider '${binding.providerId}'`
      );
    }
  }

  if (
    config.conversationTitles.enabled &&
    config.conversationTitles.modelProviderId &&
    config.conversationTitles.modelBindingId
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Conversation title generation must use either modelProviderId or modelBindingId, not both"
    );
  }

  if (
    config.conversationTitles.enabled &&
    config.conversationTitles.modelProviderId &&
    !providerIds.has(config.conversationTitles.modelProviderId)
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Conversation title generation references missing model provider '${config.conversationTitles.modelProviderId}'`
    );
  }

  if (
    config.conversationTitles.enabled &&
    config.conversationTitles.modelBindingId &&
    !modelBindingIds.has(config.conversationTitles.modelBindingId)
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Conversation title generation references missing model binding '${config.conversationTitles.modelBindingId}'`
    );
  }
}

/**
 * Embeddings send the text of documents and queries to their provider, so the approved route is
 * part of the config: an embedding binding sits on an entry with region `eu` or on one that keeps
 * data inside the instance. A chat use of the product never names an embedding binding, and the
 * default of `knowledge` names nothing else.
 */
function assertEmbeddingBindings(config: ClientInstanceConfig): void {
  const providers = getModelProviderConfigs(config);
  for (const binding of config.modelBindings) {
    if (binding.kind !== "embedding") continue;
    const region = providers.find((provider) => provider.id === binding.providerId)?.region;
    if (region !== undefined && region !== "eu") {
      throw new AppError(
        "VALIDATION_FAILED",
        `Embedding binding '${binding.id}' is on model provider '${binding.providerId}', whose region is '${region}': embeddings send document text to their provider and need an entry with region 'eu'`
      );
    }
  }
  const embeddingBindingIds = new Set(
    config.modelBindings
      .filter((binding) => binding.kind === "embedding")
      .map((binding) => binding.id)
  );
  const { conversationTitles } = config;
  const chatUses = [
    ...Object.entries(config.guardrails).map(([name, guardrail]) => ({
      user: `Guardrail '${name}'`,
      bindingId: guardrail.check.modelBindingId
    })),
    ...(conversationTitles.enabled && conversationTitles.modelBindingId
      ? [{ user: "Conversation title generation", bindingId: conversationTitles.modelBindingId }]
      : [])
  ];
  for (const { user, bindingId } of chatUses) {
    if (embeddingBindingIds.has(bindingId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `${user} names the embedding binding '${bindingId}', which answers no chat call`
      );
    }
  }
  const defaultBinding = config.knowledge.defaultEmbeddingBinding;
  if (defaultBinding !== undefined && !embeddingBindingIds.has(defaultBinding)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'knowledge.defaultEmbeddingBinding' names '${defaultBinding}', which is no model binding of kind 'embedding'`
    );
  }
}

/**
 * A call reserves `MODEL_CALL_RESERVED_OUTPUT_TOKENS` for its answer and the size of its
 * request on top, and is admitted only while that fits under the token limits. A limit at or
 * below the reservation would start an instance that refuses every call.
 */
function assertTokenSafeguardsAdmitACall(config: ClientInstanceConfig): void {
  const { tokensPerDay, tokensPerMonth } = config.usage.safeguards;
  const limits: [string, number | undefined][] = [
    ["usage.safeguards.tokensPerDay", tokensPerDay],
    ["usage.safeguards.tokensPerMonth", tokensPerMonth]
  ];
  for (const [key, limit] of limits) {
    if (limit !== undefined && limit <= MODEL_CALL_RESERVED_OUTPUT_TOKENS) {
      throw new AppError(
        "VALIDATION_FAILED",
        `${key} is ${limit}, but one model call reserves ${MODEL_CALL_RESERVED_OUTPUT_TOKENS} tokens for its answer and the size of its request on top, so no call would be admitted. Set it above ${MODEL_CALL_RESERVED_OUTPUT_TOKENS} or leave it out`
      );
    }
  }
}

/** A fast run must never be settled with the normal rates, so fast rates are mandatory. */
function assertFastModePricingCoverage(config: ClientInstanceConfig): void {
  const models = config.usage.costs.customer?.models ?? [];
  for (const binding of config.modelBindings) {
    if (!binding.supportsFastMode) {
      continue;
    }
    const selection = resolveModelBinding(config, binding.id);
    const hasFastRates = models.some(
      (price) =>
        price.providerId === selection.provider.id &&
        price.model === selection.model &&
        price.fast !== undefined
    );
    if (!hasFastRates) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Model binding '${binding.id}' declares supportsFastMode, but the customer rate card has no fast rates for model ${createPricingKey(selection.provider.id, selection.model)}`
      );
    }
  }
}

export function assertSpendBudgetPricingCoverage(
  config: ClientInstanceConfig,
  agents: readonly AgentConfig[]
): void {
  if (!config.usage.budget.dailySpendLimit && !config.usage.budget.monthlySpendLimit) {
    return;
  }

  const customerRateCard = config.usage.costs.customer;
  if (!customerRateCard) {
    throw new AppError("VALIDATION_FAILED", "Spend budget requires an explicit customer rate card");
  }

  const priceKeys = new Set(
    customerRateCard.models.map((price) => createPricingKey(price.providerId, price.model))
  );
  const requiredPrices = new Set<string>();

  for (const agent of agents) {
    const selection = getModelSelectionForAgent(config, agent);
    if (selection.provider.type !== "deterministic") {
      requiredPrices.add(createPricingKey(selection.provider.id, selection.model));
    }
  }

  if (config.conversationTitles.enabled) {
    const selection = getModelSelectionForConversationTitles(config);
    if (selection.provider.type !== "deterministic") {
      requiredPrices.add(createPricingKey(selection.provider.id, selection.model));
    }
  }

  const pricedBindingIds = [
    ...Object.values(config.guardrails).map((guardrail) => guardrail.check.modelBindingId),
    // Ingestion and search call them without an agent; the budget bounds them all the same.
    ...config.modelBindings
      .filter((binding) => binding.kind === "embedding")
      .map((binding) => binding.id)
  ];
  for (const bindingId of pricedBindingIds) {
    const selection = resolveModelBinding(config, bindingId);
    if (selection.provider.type !== "deterministic") {
      requiredPrices.add(createPricingKey(selection.provider.id, selection.model));
    }
  }

  const missingPrices = [...requiredPrices].filter((priceKey) => !priceKeys.has(priceKey));
  if (missingPrices.length === 0) {
    return;
  }

  throw new AppError(
    "VALIDATION_FAILED",
    `Spend budget requires configured customer pricing for model ${missingPrices.join(", ")}`
  );
}

function createPricingKey(providerId: string, model: string): string {
  return `${providerId}/${model}`;
}
