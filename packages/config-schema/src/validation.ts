import { AppError, MODEL_CALL_RESERVED_OUTPUT_TOKENS } from "@vivd-catalyst/core";
import { clientInstanceConfigSchema, type AgentConfig, type ClientInstanceConfig } from "./schemas";
import { isPasswordMailEnabled } from "./branding";
import { resolveModuleSwitches } from "./module-normalization";
import { findDuplicates } from "./reference-validation";
import { withoutRemovedWorkspaceSwitch } from "./removed-workspace-switch";
import { getModelProviderConfigs } from "./infrastructure";
import { refuseMovedInfrastructureKeys } from "./moved-infrastructure-keys";
import {
  getModelSelectionForAgent,
  getModelSelectionForConversationTitles,
  resolveModelBinding
} from "./selectors";

export function parseClientInstanceConfig(input: unknown): ClientInstanceConfig {
  refuseMovedInfrastructureKeys(input);
  const parsed = clientInstanceConfigSchema.safeParse(withoutRemovedUiSwitch(input));
  if (!parsed.success) {
    throw invalidConfigError("Client instance config is invalid", parsed.error.issues);
  }

  assertProductionSafeAuthConfig(parsed.data);
  assertCaptureMailIsDevelopmentOnly(parsed.data);
  assertExecutionWorkspaceInfrastructure(parsed.data);
  assertModuleSwitches(parsed.data);
  assertConfigReferences(parsed.data);
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

/**
 * The message carries the first issue, so a log line or a terminal names the key that stopped
 * startup. Issue messages come from the schemas and quote no config value.
 */
export function invalidConfigError(
  summary: string,
  issues: readonly { path: PropertyKey[]; message: string }[]
): AppError {
  const first = issues[0];
  const detail = first ? `: ${first.path.map(String).join(".")}: ${first.message}` : "";
  return new AppError("VALIDATION_FAILED", `${summary}${detail}`, { issues });
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
  for (const check of config.approvalChecks) {
    if (!modelBindingIds.has(check.modelBindingId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Approval check '${check.id}' references missing model binding '${check.modelBindingId}'`
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

  for (const check of config.approvalChecks) {
    const selection = resolveModelBinding(config, check.modelBindingId);
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
