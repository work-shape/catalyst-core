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
  fastModeModelBindingIds: readonly string[];
}): string[] {
  const providerIds = new Set(input.modelProviderIds);
  const bindingIds = new Set(input.modelBindingIds);
  const fastModeBindingIds = new Set(input.fastModeModelBindingIds);
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
    if (agent.fastMode && !(agent.modelBindingId && fastModeBindingIds.has(agent.modelBindingId))) {
      issues.push(
        agent.modelBindingId
          ? `Agent '${agent.name}' enables fastMode, but model binding '${agent.modelBindingId}' does not support fast mode`
          : `Agent '${agent.name}' enables fastMode without a model binding that supports fast mode`
      );
    }
    const userSelectable = new Set(agent.userSelectableModelBindingIds ?? []);
    for (const bindingId of Object.keys(agent.modelReasoningEfforts ?? {})) {
      if (!userSelectable.has(bindingId)) {
        issues.push(
          `Agent '${agent.name}' sets modelReasoningEfforts for '${bindingId}', which is not in its userSelectableModelBindingIds`
        );
      }
    }
  }
  return issues;
}

/**
 * Checked when an agent's list is written, not for the stored bundle: a binding that later
 * disappears or stops being agent-selectable is ignored at read time instead of failing the agent.
 */
export function findAgentUserSelectableModelIssues(
  agent: Pick<AgentConfig, "name" | "userSelectableModelBindingIds">,
  modelBindingIds: readonly string[]
): string[] {
  const eligible = new Set(modelBindingIds);
  return (agent.userSelectableModelBindingIds ?? [])
    .filter((bindingId) => !eligible.has(bindingId))
    .map(
      (bindingId) =>
        `Agent '${agent.name}' lists missing model binding '${bindingId}' in userSelectableModelBindingIds`
    );
}

export function findMissingAgentSkillReferences(
  agents: readonly AgentConfig[],
  skillNames: readonly string[]
): MissingAgentReference[] {
  return findMissingAgentReferences(agents, skillNames, (agent) => agent.skillNames);
}

/**
 * The name of a tool that is an operation of a Connection: `connection.<name>.<operation>`.
 * Neither part holds a dot, so a name reads one way only.
 *
 * Local until `core/src/connection-operations.ts` exists (C1 slice K). Then this is
 * `parseConnectionOperationName` of core, and the rules of the two parts are the ones
 * `core/src/connections.ts` names.
 */
const CONNECTION_OPERATION_PREFIX = "connection.";
const CONNECTION_NAME_PATTERN = /^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/u;
const CONNECTION_OPERATION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const CONNECTION_NAME_PART_MAX_LENGTH = 64;

function isConnectionOperationName(name: string): boolean {
  if (!name.startsWith(CONNECTION_OPERATION_PREFIX)) {
    return false;
  }
  const parts = name.slice(CONNECTION_OPERATION_PREFIX.length).split(".");
  const [connection, operation] = parts;
  return (
    parts.length === 2 &&
    connection !== undefined &&
    operation !== undefined &&
    connection.length <= CONNECTION_NAME_PART_MAX_LENGTH &&
    operation.length <= CONNECTION_NAME_PART_MAX_LENGTH &&
    CONNECTION_NAME_PATTERN.test(connection) &&
    CONNECTION_OPERATION_NAME_PATTERN.test(operation)
  );
}

/**
 * The tools an agent lists and this instance does not offer. A tool of the release is known
 * from the release. A tool that is an operation of a Connection exists as data and comes and
 * goes without a release, so a well-formed name of one is no missing reference: the run reads
 * whether it exists and goes on without one that does not. Any other name with that prefix is
 * a name of nothing and is reported.
 */
export function findMissingAgentToolReferences(
  agents: readonly AgentConfig[],
  enabledToolNames: readonly string[]
): MissingAgentReference[] {
  return findMissingAgentReferences(agents, enabledToolNames, (agent) =>
    agent.toolNames.filter((toolName) => !isConnectionOperationName(toolName))
  );
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
