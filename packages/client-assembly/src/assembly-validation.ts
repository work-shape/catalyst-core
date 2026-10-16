import { findModelToolMaterializationIssues } from "@work-shape/catalyst-agent-runtime";
import {
  type ApprovalRequestHandlerRegistry,
  AppError,
  type ModuleSnapshot
} from "@work-shape/catalyst-core";
import { toolEffectIssue } from "@work-shape/catalyst-tool-execution";
import {
  WEB_SEARCH_MODEL_TOOL_NAME,
  type ModelBindingRef,
  type ModelCapabilities
} from "@work-shape/catalyst-model-provider";
import {
  getModelProviderConfigs,
  getModelSelectionForAgent,
  type AgentConfig,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import type { AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import type { ClientInstanceCapability } from "./capabilities";

export function assertClientAssemblyValid(input: {
  config: ClientInstanceConfig;
  tools: AnyToolDefinition[];
  approvalRequestHandlers?: ApprovalRequestHandlerRegistry;
  /** With the modules given, a tool of a module that is off needs no implementation. */
  modules?: ModuleSnapshot;
}): void {
  const issues = [
    ...findDuplicateToolImplementations(input.tools),
    ...Object.entries(input.config.guardrails).flatMap(([name, guardrail]) => {
      // On an approval request the kind is the request's; on an asset write it is the asset's.
      const kind =
        guardrail.on === "approval_request.before_create" ? guardrail.filter?.kind : undefined;
      return kind === undefined || input.approvalRequestHandlers?.has(kind)
        ? []
        : [
            `Guardrail '${name}' filters on approval request kind '${kind}' with no registered handler`
          ];
    }),
    ...findModelProviderReferenceIssues(input.config),
    ...findToolReferenceIssues(input.config, input.tools, input.modules)
  ];

  if (issues.length > 0) {
    throw new AppError("VALIDATION_FAILED", "Client instance assembly is invalid", {
      issues: issues.map((message) => ({ message }))
    });
  }
}

/** An agent may not name a tool of a module that is off. Each issue names the module. */
export function findModuleOffToolIssues(
  modules: ModuleSnapshot,
  agents: readonly Pick<AgentConfig, "name" | "toolNames">[]
): string[] {
  return agents.flatMap((agent) =>
    agent.toolNames.flatMap((toolName) => {
      const module = modules.offModuleOf("tool", toolName);
      return module === undefined
        ? []
        : [
            `Agent '${agent.name}' references tool '${toolName}' of module '${module}', which is off`
          ];
    })
  );
}

export function findConfigAssetAgentValidationIssues(
  config: ClientInstanceConfig,
  agents: AgentConfig[],
  /** What a model can do, as the instance's gateway reports it. */
  capabilitiesOf: (binding: ModelBindingRef) => ModelCapabilities
): string[] {
  return agents.flatMap((agent) => {
    if (
      agent.toolNames.includes("propose_skill_change") &&
      !config.administration.agentConfiguration.agentSkillChanges.enabled
    ) {
      return [
        `Agent '${agent.name}' references propose_skill_change but agent skill changes are disabled`
      ];
    }
    if (!agent.toolNames.includes(WEB_SEARCH_MODEL_TOOL_NAME)) {
      return [];
    }
    try {
      const selection = getModelSelectionForAgent(config, agent);
      const materializationIssues = findModelToolMaterializationIssues({
        agent,
        capabilities: capabilitiesOf({
          providerId: selection.provider.id,
          model: selection.model
        }),
        webAccess: config.webAccess
      });
      if (materializationIssues.length > 0) {
        return materializationIssues;
      }

      const hasCustomerRate = config.usage.costs.customer?.webSearch.some(
        (rate) =>
          rate.providerId === selection.provider.id &&
          (rate.model === undefined || rate.model === selection.model)
      );
      return hasCustomerRate
        ? []
        : [
            `Agent '${agent.name}' references web_search but customer pricing is missing for ${selection.provider.id}/${selection.model}`
          ];
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
  const configuredProviderIds = new Set(
    getModelProviderConfigs(config).map((provider) => provider.id)
  );
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
    issues.push(
      "Conversation title generation must use either modelProviderId or modelBindingId, not both"
    );
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
  tools: AnyToolDefinition[],
  modules?: ModuleSnapshot
): string[] {
  const issues: string[] = [];
  const providedTools = new Map(tools.map((tool) => [tool.name, tool]));
  const providedToolNames = new Set(providedTools.keys());

  for (const tool of config.tools) {
    if (tool.name === WEB_SEARCH_MODEL_TOOL_NAME) {
      continue;
    }
    // The capability of a module that is off brings no tools, and the config that enables
    // them stays as it is: the instance starts, and nobody is offered the tool.
    if (modules?.offModuleOf("tool", tool.name) !== undefined) {
      continue;
    }
    if (tool.enabled && !providedToolNames.has(tool.name)) {
      issues.push(
        `Enabled tool '${tool.name}' has no implementation registered by the client assembly app`
      );
    }
    const provided = providedTools.get(tool.name);
    const effectIssue = provided ? toolEffectIssue(provided) : undefined;
    if (effectIssue) {
      issues.push(effectIssue);
      continue;
    }
    if (
      tool.enabled &&
      provided?.effect === "reading" &&
      provided.permission?.mode === "approval_required"
    ) {
      // An approval is a value of changing operations. Left to the policy, the mode would
      // not apply and the tool would run unasked, which its definition says it must not.
      issues.push(
        `Tool '${tool.name}' requires approval and declares that it only reads. An approval holds a changing call: declare the effect 'changing' or another mode.`
      );
    }
  }

  return issues;
}

/**
 * Stops a build whose capabilities do not match the `capabilities` section of the config: two
 * that register one key, or a key no capability of the build registers. It needs the config
 * and the build alone, so a process makes it before it opens a store.
 */
export function assertCapabilityConfigKeys(
  capabilities: readonly ClientInstanceCapability[],
  config: Record<string, unknown>
): void {
  const registeredKeys = capabilities.flatMap((capability) =>
    capability.configKey ? [capability.configKey] : []
  );
  const duplicateKeys = registeredKeys.filter(
    (key, index) => registeredKeys.indexOf(key) !== index
  );
  if (duplicateKeys.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Duplicate capability config registrations: ${[...new Set(duplicateKeys)].join(", ")}`
    );
  }
  const registered = new Set(registeredKeys);
  const unknown = Object.keys(config).filter((key) => !registered.has(key));
  if (unknown.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Capability config has no registered implementation: ${unknown.join(", ")}`
    );
  }
}
