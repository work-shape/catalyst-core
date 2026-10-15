import type { AgentToolReference, ConfigAssetValidationRefs } from "@vivd-catalyst/chat-server";
import { getEnabledToolNames, type ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  REASONING_EFFORTS,
  type ModuleSnapshot,
  type ModelProviderConfig
} from "@vivd-catalyst/core";
import { WEB_SEARCH_MODEL_TOOL_NAME } from "@vivd-catalyst/model-provider";
import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import { agentListableToolNames } from "./platform-orientation";

/**
 * What a definition of the instance may refer to, and the tools it offers with what each tells
 * people. The tools are described once the assembly registered them, which needs what is built
 * from the references, so `describe` fills them later and `tools` reads them on each ask.
 */
export function createConfigAssetReferences(
  config: ClientInstanceConfig,
  modelProviders: readonly ModelProviderConfig[],
  modules: ModuleSnapshot
) {
  const selectable = config.modelBindings.filter((binding) => binding.agentSelectable !== false);
  const validationRefs: ConfigAssetValidationRefs = {
    modelProviderIds: modelProviders.map((provider) => provider.id),
    modelBindingIds: selectable.map((binding) => binding.id),
    modelBindings: selectable.map((binding) => {
      const model =
        binding.model ??
        modelProviders.find((provider) => provider.id === binding.providerId)?.model;
      if (model === undefined) throw new Error(`Model binding ${binding.id} has no model`);
      return { id: binding.id, model, ...(binding.label ? { label: binding.label } : {}) };
    }),
    fastModeModelBindingIds: fastModeModelBindingIds(config),
    reasoningEfforts: [...REASONING_EFFORTS],
    enabledToolNames: agentListableToolNames(getEnabledToolNames(config)),
    registeredToolNames: modules.modules.flatMap((module) => module.definition?.tools ?? [])
  };
  let described: AgentToolReference[] = [];
  return {
    validationRefs,
    tools: (): readonly AgentToolReference[] => described,
    describe(tools: readonly AnyToolDefinition[]): void {
      validationRefs.registeredToolNames = [
        ...new Set([
          ...(validationRefs.registeredToolNames ?? []),
          ...tools.map((tool) => tool.name),
          ...MODEL_TOOL_REFERENCES.map((tool) => tool.name)
        ])
      ];
      described = agentToolReferences(validationRefs.enabledToolNames, tools);
    }
  };
}

export function fastModeModelBindingIds(config: ClientInstanceConfig): string[] {
  return config.modelBindings
    .filter((binding) => binding.supportsFastMode)
    .map((binding) => binding.id);
}

/** Tools the model provider carries out itself: no code registers them, so they are told here. */
const MODEL_TOOL_REFERENCES: readonly AgentToolReference[] = [
  {
    name: WEB_SEARCH_MODEL_TOOL_NAME,
    title: { en: "Search the web", de: "Im Web suchen" },
    summary: {
      en: "Searches the web and answers with the sources it found.",
      de: "Sucht im Web und antwortet mit den Quellen, die es gefunden hat."
    },
    group: "web",
    icon: "web",
    effect: "reading"
  }
];

/**
 * The named tools with what each tells people, from their registered definitions. A name no
 * definition registers is listed by its name alone.
 */
export function agentToolReferences(
  names: readonly string[],
  tools: readonly AnyToolDefinition[]
): AgentToolReference[] {
  const byName = new Map<string, AgentToolReference>(
    MODEL_TOOL_REFERENCES.map((tool) => [tool.name, tool])
  );
  for (const tool of tools) {
    byName.set(tool.name, {
      name: tool.name,
      effect: tool.effect,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.summary ? { summary: tool.summary } : {}),
      ...(tool.group ? { group: tool.group } : {}),
      ...(tool.icon ? { icon: tool.icon } : {})
    });
  }
  return names.map((name) => byName.get(name) ?? { name });
}
