import { findModelToolMaterializationIssues } from "@vivd-catalyst/agent-runtime";
import { AppError } from "@vivd-catalyst/core";
import { WEB_SEARCH_MODEL_TOOL_NAME } from "@vivd-catalyst/model-provider";
import {
  getModelSelectionForAgent,
  type AgentConfig,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

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

export function findConfigAssetAgentValidationIssues(
  config: ClientInstanceConfig,
  agents: AgentConfig[]
): string[] {
  return agents.flatMap((agent) => {
    if (!agent.toolNames.includes(WEB_SEARCH_MODEL_TOOL_NAME)) {
      return [];
    }
    try {
      return findModelToolMaterializationIssues({
        agent,
        modelProvider: getModelSelectionForAgent(config, agent).provider,
        webAccess: config.webAccess
      });
    } catch {
      // Unknown model references are rejected by config-asset validation first.
      return [];
    }
  });
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

  return issues;
}

function findToolReferenceIssues(
  config: ClientInstanceConfig,
  tools: AnyToolDefinition[]
): string[] {
  const issues: string[] = [];
  const providedTools = new Map(tools.map((tool) => [tool.name, tool]));
  const providedToolNames = new Set(providedTools.keys());

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

  return issues;
}
