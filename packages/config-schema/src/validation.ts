import { AppError } from "@vivd-catalyst/core";
import {
  clientInstanceConfigSchema,
  type AgentConfig,
  type ClientInstanceConfig
} from "./schemas";
import {
  findAgentModelReferenceIssues,
  findDefaultAgentReferenceIssues,
  findDuplicates,
  findMissingAgentSkillReferences
} from "./reference-validation";
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
  const defaultAgentIssues = findDefaultAgentReferenceIssues({
    agentNames: config.agents.map((agent) => agent.name),
    defaultAgentName: config.defaultAgentName
  });
  if (defaultAgentIssues[0]) {
    throw new AppError("VALIDATION_FAILED", defaultAgentIssues[0]);
  }

  const duplicateAgentNames = findDuplicates(config.agents.map((agent) => agent.name));
  if (duplicateAgentNames.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Duplicate agent definitions: ${duplicateAgentNames.join(", ")}`
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

  const agentModelIssues = findAgentModelReferenceIssues({
    agents: config.agents,
    modelProviderIds: [...providerIds],
    modelBindingIds: [...modelBindingIds]
  });
  if (agentModelIssues[0]) {
    throw new AppError("VALIDATION_FAILED", agentModelIssues[0]);
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

  const missingSkillReferences = findMissingAgentSkillReferences(
    config.agents,
    config.skills.map((skill) => skill.name)
  );
  if (missingSkillReferences[0]) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Agent '${missingSkillReferences[0].agentName}' references missing skill '${missingSkillReferences[0].referenceName}'`
    );
  }
}

export function assertSpendBudgetPricingCoverage(
  config: ClientInstanceConfig,
  agents: readonly AgentConfig[] = config.agents
): void {
  if (!config.usage.budget.monthlySpendLimit) {
    return;
  }

  const priceKeys = new Set(
    config.usage.pricing.models.map((price) => createPricingKey(price.providerId, price.model))
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
