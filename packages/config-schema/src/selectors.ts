import { AppError, asClientInstanceId } from "@vivd-catalyst/core";
import type { AgentConfig, ClientInstanceConfig, ModelProviderConfig } from "./schemas";

export function getClientInstanceId(config: ClientInstanceConfig) {
  return asClientInstanceId(config.clientInstance.id);
}

export function getAgentConfig(config: ClientInstanceConfig, agentName: string): AgentConfig {
  const agent = config.agents.find((candidate) => candidate.name === agentName);
  if (!agent) {
    throw new AppError("NOT_FOUND", `Agent '${agentName}' is not defined`);
  }
  return agent;
}

export function getModelProviderForAgent(
  config: ClientInstanceConfig,
  agent: AgentConfig
): ModelProviderConfig {
  const providerId = agent.modelProviderId ?? config.modelProviders[0]?.id;
  const provider = config.modelProviders.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new AppError("NOT_FOUND", `Model provider '${providerId}' is not defined`);
  }
  return provider;
}

export function getModelProviderForConversationTitles(config: ClientInstanceConfig): ModelProviderConfig {
  const providerId = config.conversationTitles.modelProviderId ?? config.modelProviders[0]?.id;
  const provider = config.modelProviders.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new AppError("NOT_FOUND", `Model provider '${providerId}' is not defined`);
  }
  return provider;
}

export function getEnabledToolNames(config: ClientInstanceConfig): Set<string> {
  return new Set(config.tools.filter((tool) => tool.enabled).map((tool) => tool.name));
}
