import { AppError } from "@vivd-catalyst/core";
import { findModelToolMaterializationIssues } from "@vivd-catalyst/agent-runtime";
import { WEB_SEARCH_MODEL_TOOL_NAME } from "@vivd-catalyst/model-provider";
import type {
  AgentConfig,
  ClientInstanceConfig,
  ModelProviderConfig
} from "@vivd-catalyst/config-schema";
import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

const READ_SKILL_TOOL_NAME = "read_skill";

export function assertClientAssemblyValid(input: {
  config: ClientInstanceConfig;
  tools: AnyToolDefinition[];
}): void {
  const issues = [
    ...findDuplicateToolImplementations(input.tools),
    ...findModelProviderReferenceIssues(input.config),
    ...findToolReferenceIssues(input.config, input.tools)
  ];

  if (issues.length > 0) {
    throw new AppError("VALIDATION_FAILED", "Client instance assembly is invalid", {
      issues: issues.map((message) => ({ message }))
    });
  }
}

function findDuplicateToolImplementations(tools: AnyToolDefinition[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      duplicates.add(tool.name);
    }
    seen.add(tool.name);
  }
  return [...duplicates].map((toolName) => `Duplicate tool implementation '${toolName}'`);
}

function findModelProviderReferenceIssues(config: ClientInstanceConfig): string[] {
  const issues: string[] = [];
  const configuredProviderIds = new Set(config.modelProviders.map((provider) => provider.id));
  const configuredModelBindingIds = new Set(config.modelBindings.map((binding) => binding.id));

  for (const binding of config.modelBindings) {
    if (!configuredProviderIds.has(binding.providerId)) {
      issues.push(
        `Model binding '${binding.id}' references model provider '${binding.providerId}' that is missing from release config`
      );
    }
  }

  if (
    config.conversationTitles.enabled &&
    config.conversationTitles.modelProviderId &&
    config.conversationTitles.modelBindingId
  ) {
    issues.push("Conversation title generation must use either modelProviderId or modelBindingId, not both");
  }

  if (
    config.conversationTitles.enabled &&
    config.conversationTitles.modelProviderId &&
    !configuredProviderIds.has(config.conversationTitles.modelProviderId)
  ) {
    issues.push(
      `Conversation title generation references model provider '${config.conversationTitles.modelProviderId}' that is missing from release config`
    );
  }

  if (
    config.conversationTitles.enabled &&
    config.conversationTitles.modelBindingId &&
    !configuredModelBindingIds.has(config.conversationTitles.modelBindingId)
  ) {
    issues.push(
      `Conversation title generation references model binding '${config.conversationTitles.modelBindingId}' that is missing from release config`
    );
  }

  for (const agent of config.agents) {
    if (agent.modelProviderId && agent.modelBindingId) {
      issues.push(`Agent '${agent.name}' must use either modelProviderId or modelBindingId, not both`);
    }
    if (agent.modelProviderId && !configuredProviderIds.has(agent.modelProviderId)) {
      issues.push(
        `Agent '${agent.name}' references model provider '${agent.modelProviderId}' that is missing from release config`
      );
    }
    if (agent.modelBindingId && !configuredModelBindingIds.has(agent.modelBindingId)) {
      issues.push(
        `Agent '${agent.name}' references model binding '${agent.modelBindingId}' that is missing from release config`
      );
    }
  }

  return issues;
}

function findToolReferenceIssues(
  config: ClientInstanceConfig,
  tools: AnyToolDefinition[]
): string[] {
  const issues: string[] = [];
  const providedTools = new Map(tools.map((tool) => [tool.name, tool]));
  const providedToolNames = new Set(providedTools.keys());
  const configuredTools = new Map(config.tools.map((tool) => [tool.name, tool.enabled]));

  for (const tool of config.tools) {
    if (tool.name === WEB_SEARCH_MODEL_TOOL_NAME) {
      continue;
    }
    if (tool.enabled && !providedToolNames.has(tool.name)) {
      issues.push(`Enabled tool '${tool.name}' has no implementation registered by the client assembly app`);
    }
    if (tool.enabled && providedTools.get(tool.name)?.permission?.mode === "approval_required") {
      issues.push(
        `Tool '${tool.name}' requires approval, but v1 client assembly does not support approval-required tool policies yet`
      );
    }
  }

  for (const agent of config.agents) {
    const skillNames = agent.skillNames ?? [];
    if (skillNames.length > 0 && !agent.toolNames.includes(READ_SKILL_TOOL_NAME)) {
      issues.push(
        `Agent '${agent.name}' references skills but does not allow '${READ_SKILL_TOOL_NAME}'`
      );
    }
    for (const toolName of agent.toolNames) {
      if (!configuredTools.has(toolName)) {
        issues.push(`Agent '${agent.name}' references tool '${toolName}' that is missing from release config`);
        continue;
      }
      if (!configuredTools.get(toolName)) {
        issues.push(`Agent '${agent.name}' references disabled tool '${toolName}'`);
      }
      if (toolName === WEB_SEARCH_MODEL_TOOL_NAME) {
        const modelProvider = getModelProviderForAgentValidation(config, agent);
        if (modelProvider) {
          issues.push(
            ...findModelToolMaterializationIssues({
              agent,
              modelProvider,
              webAccess: config.webAccess
            })
          );
        }
        continue;
      }
      if (!providedToolNames.has(toolName)) {
        issues.push(`Agent '${agent.name}' references tool '${toolName}' with no registered implementation`);
      }
    }
  }

  return issues;
}

function getModelProviderForAgentValidation(
  config: ClientInstanceConfig,
  agent: AgentConfig
): ModelProviderConfig | undefined {
  if (agent.modelProviderId && agent.modelBindingId) {
    return undefined;
  }
  if (agent.modelBindingId) {
    const binding = config.modelBindings.find((candidate) => candidate.id === agent.modelBindingId);
    if (!binding) {
      return undefined;
    }
    return config.modelProviders.find((provider) => provider.id === binding.providerId);
  }
  const providerId = agent.modelProviderId ?? config.modelProviders[0]?.id;
  return config.modelProviders.find((provider) => provider.id === providerId);
}
