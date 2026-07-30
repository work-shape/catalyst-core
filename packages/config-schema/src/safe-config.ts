import type { ModelProviderConfig, RuntimeAssetSnapshot } from "@vivd-catalyst/core";
import type { ClientInstanceConfig } from "./schemas";
import { createClientBranding } from "./branding";
import {
  getModelSelectionForAgent
} from "./selectors";
import {
  resolveConfigLocale,
  resolveLocalizedString,
  type ConfigLocaleInput
} from "./localization";

export function createSafeConfigView(
  config: ClientInstanceConfig,
  assets: RuntimeAssetSnapshot,
  localeInput: ConfigLocaleInput = {}
) {
  const locale = resolveConfigLocale(config.localization, localeInput);
  const { environment: _environment, ...ui } = createClientBranding(config, {
    requestedLocale: locale
  });
  const selectableModels = config.modelBindings
    .filter((binding) => binding.userSelectable)
    .map((binding) => ({
      bindingId: binding.id,
      model:
        binding.model ??
        config.modelProviders.find((provider) => provider.id === binding.providerId)!.model,
      ...compactionThresholdView(
        config.modelProviders.find((provider) => provider.id === binding.providerId)!
      )
    }));
  const selectableModelBindingIds = new Set(
    selectableModels.map((model) => model.bindingId)
  );

  return {
    clientInstance: {
      id: config.clientInstance.id,
      displayName: config.clientInstance.displayName,
      environment: config.clientInstance.environment
    },
    localization: {
      locale,
      defaultLocale: config.localization.defaultLocale,
      supportedLocales: config.localization.supportedLocales
    },
    retention: config.retention,
    usage: {
      safeguards: config.usage.safeguards
    },
    features: {
      attachments: {
        enabled: false,
        accept: ""
      },
      configAssets: {
        ...config.administration.agentConfiguration
      }
    },
    defaultAgentName: assets.defaultAgentName,
    selectableModels,
    agents: assets.agents.map((agent) => ({
      name: agent.name,
      displayName: resolveLocalizedString(agent.displayName, locale, config.localization.defaultLocale),
      ...compactionThresholdView(getModelSelectionForAgent(config, agent).provider),
      ...(agent.modelBindingId && selectableModelBindingIds.has(agent.modelBindingId)
        ? { defaultModelBindingId: agent.modelBindingId }
        : {}),
      welcomeMessage: resolveLocalizedString(
        agent.welcomeMessage,
        locale,
        config.localization.defaultLocale
      ),
      welcomeSubtitle: resolveLocalizedString(
        agent.welcomeSubtitle,
        locale,
        config.localization.defaultLocale
      ),
      initialPrompts: agent.initialPrompts.map((initialPrompt) => ({
        title: resolveLocalizedString(initialPrompt.title, locale, config.localization.defaultLocale),
        prompt: resolveLocalizedString(initialPrompt.prompt, locale, config.localization.defaultLocale)
      }))
    })),
    ui
  };
}

function compactionThresholdView(
  provider: ModelProviderConfig
): { compactThresholdTokens?: number } {
  const compactThresholdTokens =
    provider.type === "openai-compatible"
      ? provider.contextManagement?.compaction?.compactThresholdTokens
      : undefined;
  return compactThresholdTokens === undefined ? {} : { compactThresholdTokens };
}
