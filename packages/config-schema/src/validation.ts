import { AppError } from "@vivd-stage/core";
import { clientInstanceConfigSchema, type ClientInstanceConfig } from "./schemas";

export function parseClientInstanceConfig(input: unknown): ClientInstanceConfig {
  const parsed = clientInstanceConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Client instance config is invalid", {
      issues: parsed.error.issues
    });
  }

  assertProductionSafeAuthConfig(parsed.data);
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

function assertConfigReferences(config: ClientInstanceConfig): void {
  const agentNames = new Set(config.agents.map((agent) => agent.name));
  if (!agentNames.has(config.defaultAgentName)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Default agent '${config.defaultAgentName}' is not defined`
    );
  }

  const providerIds = new Set(config.modelProviders.map((provider) => provider.id));
  for (const agent of config.agents) {
    if (agent.modelProviderId && !providerIds.has(agent.modelProviderId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Agent '${agent.name}' references missing model provider '${agent.modelProviderId}'`
      );
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

  for (const provider of config.modelProviders) {
    if (provider.type !== "deterministic") {
      requiredPrices.add(createPricingKey(provider.id, provider.model));
    }
  }

  if (config.conversationTitles.enabled && config.conversationTitles.model) {
    const providerId = config.conversationTitles.modelProviderId ?? config.modelProviders[0]?.id;
    const provider = config.modelProviders.find((candidate) => candidate.id === providerId);
    if (provider && provider.type !== "deterministic") {
      requiredPrices.add(createPricingKey(provider.id, config.conversationTitles.model));
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
