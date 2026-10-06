import type { SafeConfig } from "@vivd-catalyst/api-client";

type SafeAgent = SafeConfig["agents"][number];
export type AgentSelectableModel = SafeAgent["selectableModels"][number];

/**
 * The models the composer offers for an agent, and the one a run would use. The agent's own
 * model comes first; the user's pick applies only while this agent offers it, so switching to
 * an agent without it falls back to that agent's own model.
 */
export function agentModelSelection(
  agent: Pick<SafeAgent, "selectableModels"> | undefined,
  pickedModelBindingId: string | undefined
): { selectableModels: AgentSelectableModel[]; selectedModel: AgentSelectableModel | undefined } {
  const selectableModels = agent?.selectableModels ?? [];
  const picked = pickedModelBindingId
    ? selectableModels.find((model) => model.bindingId === pickedModelBindingId)
    : undefined;
  return { selectableModels, selectedModel: picked ?? selectableModels[0] };
}
