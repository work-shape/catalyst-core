import type { ClientInstanceConfig } from "./schemas";
import { createClientBranding } from "./branding";

export function createSafeConfigView(config: ClientInstanceConfig) {
  return {
    clientInstance: {
      id: config.clientInstance.id,
      displayName: config.clientInstance.displayName,
      environment: config.clientInstance.environment
    },
    retention: config.retention,
    usage: {
      budget: config.usage.budget,
      safeguards: config.usage.safeguards
    },
    defaultAgentName: config.defaultAgentName,
    agents: config.agents.map((agent) => ({
      name: agent.name,
      displayName: agent.displayName,
      initialPrompts: agent.initialPrompts
    })),
    ui: createClientBranding(config)
  };
}
