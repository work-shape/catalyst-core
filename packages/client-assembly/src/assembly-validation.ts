import { AppError } from "@agent-chat-platform/core";
import type { ClientInstanceConfig } from "@agent-chat-platform/config-schema";
import type { AnyToolDefinition } from "@agent-chat-platform/tool-sdk";

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

  if (
    config.conversationTitles.enabled &&
    config.conversationTitles.modelProviderId &&
    !configuredProviderIds.has(config.conversationTitles.modelProviderId)
  ) {
    issues.push(
      `Conversation title generation references model provider '${config.conversationTitles.modelProviderId}' that is missing from release config`
    );
  }

  for (const agent of config.agents) {
    if (agent.modelProviderId && !configuredProviderIds.has(agent.modelProviderId)) {
      issues.push(
        `Agent '${agent.name}' references model provider '${agent.modelProviderId}' that is missing from release config`
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
    for (const toolName of agent.toolNames) {
      if (!configuredTools.has(toolName)) {
        issues.push(`Agent '${agent.name}' references tool '${toolName}' that is missing from release config`);
        continue;
      }
      if (!configuredTools.get(toolName)) {
        issues.push(`Agent '${agent.name}' references disabled tool '${toolName}'`);
      }
      if (!providedToolNames.has(toolName)) {
        issues.push(`Agent '${agent.name}' references tool '${toolName}' with no registered implementation`);
      }
    }
  }

  return issues;
}
