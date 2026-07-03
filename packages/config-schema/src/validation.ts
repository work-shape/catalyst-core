import { AppError } from "@vivd-catalyst/core";
import { clientInstanceConfigSchema, type ClientInstanceConfig } from "./schemas";
import {
  getModelSelectionForAgent,
  getModelSelectionForConversationTitles
} from "./selectors";

export function parseClientInstanceConfig(input: unknown): ClientInstanceConfig {
  const parsed = clientInstanceConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Client instance config is invalid", {
      issues: parsed.error.issues
    });
  }

  assertProductionSafeAuthConfig(parsed.data);
  assertExecutionWorkspaceRunnerBoundary(parsed.data);
  assertConfigReferences(parsed.data);
  assertSpendBudgetPricingCoverage(parsed.data);
  return parsed.data;
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

function assertExecutionWorkspaceRunnerBoundary(config: ClientInstanceConfig): void {
  if (
    !config.executionWorkspaces.enabled ||
    config.executionWorkspaces.runner.mode !== "local" ||
    config.clientInstance.environment === "development"
  ) {
    return;
  }

  // The local runner executes in host temp directories for development and unit tests.
  // Customer-facing enabled workspaces need the Docker runner's mounted /workspace contract.
  throw new AppError(
    "VALIDATION_FAILED",
    "Local execution workspace runner mode is only allowed for development client instances"
  );
}

function assertConfigReferences(config: ClientInstanceConfig): void {
  const agentNames = new Set(config.agents.map((agent) => agent.name));
  if (!agentNames.has(config.defaultAgentName)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Default agent '${config.defaultAgentName}' is not defined`
    );
  }

  const providerIds = new Set(config.modelProviders.map((provider) => provider.id));
  const duplicateProviderIds = findDuplicates(config.modelProviders.map((provider) => provider.id));
  if (duplicateProviderIds.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Duplicate model provider definitions: ${duplicateProviderIds.join(", ")}`
    );
  }

  const duplicateModelBindingIds = findDuplicates(config.modelBindings.map((binding) => binding.id));
  if (duplicateModelBindingIds.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Duplicate model binding definitions: ${duplicateModelBindingIds.join(", ")}`
    );
  }

  const modelBindingIds = new Set(config.modelBindings.map((binding) => binding.id));
  for (const binding of config.modelBindings) {
    if (!providerIds.has(binding.providerId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Model binding '${binding.id}' references missing model provider '${binding.providerId}'`
      );
    }
  }

  for (const agent of config.agents) {
    if (agent.modelProviderId && agent.modelBindingId) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Agent '${agent.name}' must use either modelProviderId or modelBindingId, not both`
      );
    }
    if (agent.modelProviderId && !providerIds.has(agent.modelProviderId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Agent '${agent.name}' references missing model provider '${agent.modelProviderId}'`
      );
    }
    if (agent.modelBindingId && !modelBindingIds.has(agent.modelBindingId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Agent '${agent.name}' references missing model binding '${agent.modelBindingId}'`
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

  const duplicateSkillNames = findDuplicates(config.skills.map((skill) => skill.name));
  if (duplicateSkillNames.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Duplicate skill definitions: ${duplicateSkillNames.join(", ")}`
    );
  }

  const skillNames = new Set(config.skills.map((skill) => skill.name));
  for (const agent of config.agents) {
    for (const skillName of agent.skillNames) {
      if (!skillNames.has(skillName)) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Agent '${agent.name}' references missing skill '${skillName}'`
        );
      }
    }
  }
}

function assertSpendBudgetPricingCoverage(config: ClientInstanceConfig): void {
  if (!config.usage.budget.monthlySpendLimit) {
    return;
  }

  const priceKeys = new Set(
    config.usage.pricing.models.map((price) => createPricingKey(price.providerId, price.model))
  );
  const requiredPrices = new Set<string>();

  for (const agent of config.agents) {
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

  const missingPrices = [...requiredPrices].filter((priceKey) => !priceKeys.has(priceKey));
  if (missingPrices.length === 0) {
    return;
  }

  throw new AppError(
    "VALIDATION_FAILED",
    `Monthly spend budget requires configured pricing for model ${missingPrices.join(", ")}`
  );
}

function createPricingKey(providerId: string, model: string): string {
  return `${providerId}/${model}`;
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}
