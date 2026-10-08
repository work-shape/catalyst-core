import type { SafeConfig } from "@vivd-catalyst/api-client";

type SafeAgent = SafeConfig["agents"][number];
export type AgentSelectableModel = SafeAgent["selectableModels"][number];
export type ReasoningEffort = AgentSelectableModel["selectableReasoningEfforts"][number];
/** The user's effort picks, by the binding id of the model each was made for. */
export type ReasoningEffortPicks = Readonly<Record<string, ReasoningEffort>>;

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

/**
 * The effort a run with this model would use, and the one to request for it. A pick applies
 * only while the model offers it. Nothing is requested for the model's default, so a later
 * change of that default reaches users who never moved away from it.
 */
export function modelReasoningEffortSelection(
  model: AgentSelectableModel | undefined,
  picks: ReasoningEffortPicks
): { reasoningEffort: ReasoningEffort | undefined; requested: ReasoningEffort | undefined } {
  const picked = model?.bindingId ? picks[model.bindingId] : undefined;
  if (!picked || !model?.selectableReasoningEfforts.includes(picked)) {
    return { reasoningEffort: model?.reasoningEffort, requested: undefined };
  }
  return {
    reasoningEffort: picked,
    requested: picked === model.reasoningEffort ? undefined : picked
  };
}
