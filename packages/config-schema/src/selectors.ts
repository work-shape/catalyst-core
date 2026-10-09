import { AppError, asClientInstanceId } from "@vivd-catalyst/core";
import type {
  AgentConfig,
  ClientInstanceConfig,
  ModelBindingConfig,
  ModelProviderConfig
} from "./schemas";
import { getModelProviderConfigs } from "./infrastructure";

export function getClientInstanceId(config: ClientInstanceConfig) {
  return asClientInstanceId(config.clientInstance.id);
}

export interface ResolvedModelSelection {
  provider: ModelProviderConfig;
  binding?: ModelBindingConfig;
  model: string;
  reasoningEffort?: ModelBindingConfig["reasoningEffort"];
}

export function getModelProviderForAgent(
  config: ClientInstanceConfig,
  agent: AgentConfig
): ModelProviderConfig {
  return getModelSelectionForAgent(config, agent).provider;
}

export function getModelProviderForConversationTitles(
  config: ClientInstanceConfig
): ModelProviderConfig {
  return getModelSelectionForConversationTitles(config).provider;
}

export function getModelSelectionForAgent(
  config: ClientInstanceConfig,
  agent: AgentConfig
): ResolvedModelSelection {
  if (agent.modelBindingId) {
    const selection = resolveModelBinding(config, agent.modelBindingId);
    return {
      ...selection,
      reasoningEffort: agent.reasoningEffort ?? selection.reasoningEffort
    };
  }
  const provider = resolveModelProvider(
    config,
    agent.modelProviderId ?? getModelProviderConfigs(config)[0]?.id
  );
  return {
    provider,
    model: provider.model,
    reasoningEffort: agent.reasoningEffort ?? provider.reasoningEffort
  };
}

export function getModelSelectionForConversationTitles(
  config: ClientInstanceConfig
): ResolvedModelSelection {
  if (config.conversationTitles.modelBindingId) {
    return resolveModelBinding(config, config.conversationTitles.modelBindingId);
  }
  const provider = resolveModelProvider(
    config,
    config.conversationTitles.modelProviderId ?? getModelProviderConfigs(config)[0]?.id
  );
  return {
    provider,
    model: config.conversationTitles.model ?? provider.model,
    reasoningEffort: provider.reasoningEffort
  };
}

export function resolveModelBinding(
  config: ClientInstanceConfig,
  bindingId: string
): ResolvedModelSelection {
  const binding = config.modelBindings.find((candidate) => candidate.id === bindingId);
  if (!binding) {
    throw new AppError("NOT_FOUND", `Model binding '${bindingId}' is not defined`);
  }
  const provider = resolveModelProvider(config, binding.providerId);
  return {
    provider,
    binding,
    model: binding.model ?? provider.model,
    reasoningEffort: binding.reasoningEffort ?? provider.reasoningEffort
  };
}

function resolveModelProvider(
  config: ClientInstanceConfig,
  providerId: string | undefined
): ModelProviderConfig {
  const provider = getModelProviderConfigs(config).find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new AppError("NOT_FOUND", `Model provider '${providerId}' is not defined`);
  }
  return provider;
}

export function getEnabledToolNames(config: ClientInstanceConfig): Set<string> {
  return new Set(config.tools.filter((tool) => tool.enabled).map((tool) => tool.name));
}
