import type { AgentConfig } from "@work-shape/catalyst-core";
import { findMissingAgentToolReferences } from "./reference-validation";

export type UnavailableTool =
  { name: string; reason: "module_off"; module: string } | { name: string; reason: "unknown_tool" };

export interface StoredAgentReferences {
  enabledToolNames: readonly string[];
  modelProviderIds: readonly string[];
  modelBindingIds: readonly string[];
  /** Whether the configured tool can run for this agent, including native model tools. */
  isToolAvailable?(agent: AgentConfig, name: string): boolean;
  offToolModule?(name: string): string | undefined;
}

/** Resolve stored references without changing the definition people read and edit. */
export function resolveStoredAgentReferences(
  agent: AgentConfig,
  skillNames: readonly string[],
  refs: StoredAgentReferences
) {
  const unknownTools = new Set(
    findMissingAgentToolReferences([agent], refs.enabledToolNames).map(
      (issue) => issue.referenceName
    )
  );
  const unavailableTools = agent.toolNames.flatMap((name): UnavailableTool[] => {
    const module = refs.offToolModule?.(name);
    if (module !== undefined) return [{ name, reason: "module_off", module }];
    return unknownTools.has(name) || refs.isToolAvailable?.(agent, name) === false
      ? [{ name, reason: "unknown_tool" }]
      : [];
  });
  const unavailableSkills = agent.skillNames
    .filter((name) => !skillNames.includes(name))
    .map((name) => ({ name, reason: "unknown_skill" as const }));
  const unavailableModels = [
    ...(agent.modelProviderId
      ? [{ name: agent.modelProviderId, field: "modelProviderId" as const }]
      : []),
    ...(agent.modelBindingId
      ? [{ name: agent.modelBindingId, field: "modelBindingId" as const }]
      : []),
    ...(agent.userSelectableModelBindingIds ?? []).map((name) => ({
      name,
      field: "userSelectableModelBindingIds" as const
    }))
  ]
    .filter(
      ({ name, field }) =>
        !(field === "modelProviderId" ? refs.modelProviderIds : refs.modelBindingIds).includes(name)
    )
    .map((model) => ({ ...model, reason: "unknown_model" as const }));
  // Never silently switch a stored agent to another provider, price or processing region.
  const chatAvailable = !unavailableModels.some(
    ({ field }) => field === "modelProviderId" || field === "modelBindingId"
  );
  const missingTools = new Set(unavailableTools.map(({ name }) => name));
  const missingSkills = new Set(unavailableSkills.map(({ name }) => name));
  return {
    unavailableTools,
    unavailableSkills,
    unavailableModels,
    chatAvailable,
    agent: {
      ...agent,
      toolNames: agent.toolNames.filter((name) => !missingTools.has(name)),
      skillNames: agent.skillNames.filter((name) => !missingSkills.has(name))
    }
  };
}
