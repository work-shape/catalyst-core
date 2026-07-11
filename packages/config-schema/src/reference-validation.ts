import type { AgentConfig } from "./schemas";

export interface MissingAgentReference {
  agentName: string;
  referenceName: string;
}

export function findDuplicates(values: readonly string[]): string[] {
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

export function findDefaultAgentReferenceIssues(input: {
  agentNames: readonly string[];
  defaultAgentName?: string;
}): string[] {
  if (input.agentNames.length === 0) {
    return input.defaultAgentName === undefined
      ? []
      : ["defaultAgentName must be unset when no agents are defined"];
  }
  if (input.defaultAgentName === undefined) {
    return ["defaultAgentName must be set when agents are defined"];
  }
  return input.agentNames.includes(input.defaultAgentName)
    ? []
    : [`Default agent '${input.defaultAgentName}' is not defined`];
}

export function findAgentModelReferenceIssues(input: {
  agents: readonly AgentConfig[];
  modelProviderIds: readonly string[];
  modelBindingIds: readonly string[];
}): string[] {
  const providerIds = new Set(input.modelProviderIds);
  const bindingIds = new Set(input.modelBindingIds);
  const issues: string[] = [];
  for (const agent of input.agents) {
    if (agent.modelProviderId && agent.modelBindingId) {
      issues.push(
        `Agent '${agent.name}' must use either modelProviderId or modelBindingId, not both`
      );
    }
    if (agent.modelProviderId && !providerIds.has(agent.modelProviderId)) {
      issues.push(
        `Agent '${agent.name}' references missing model provider '${agent.modelProviderId}'`
      );
    }
    if (agent.modelBindingId && !bindingIds.has(agent.modelBindingId)) {
      issues.push(
        `Agent '${agent.name}' references missing model binding '${agent.modelBindingId}'`
      );
    }
  }
  return issues;
}

export function findMissingAgentSkillReferences(
  agents: readonly AgentConfig[],
  skillNames: readonly string[]
): MissingAgentReference[] {
  return findMissingAgentReferences(agents, skillNames, (agent) => agent.skillNames);
}

export function findMissingAgentToolReferences(
  agents: readonly AgentConfig[],
  enabledToolNames: readonly string[]
): MissingAgentReference[] {
  return findMissingAgentReferences(agents, enabledToolNames, (agent) => agent.toolNames);
}

function findMissingAgentReferences(
  agents: readonly AgentConfig[],
  availableNames: readonly string[],
  selectReferences: (agent: AgentConfig) => readonly string[]
): MissingAgentReference[] {
  const available = new Set(availableNames);
  const issues: MissingAgentReference[] = [];
  for (const agent of agents) {
    for (const referenceName of selectReferences(agent)) {
      if (!available.has(referenceName)) {
        issues.push({ agentName: agent.name, referenceName });
      }
    }
  }
  return issues;
}
