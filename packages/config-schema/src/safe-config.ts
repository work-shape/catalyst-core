import {
  userSelectableModelBindingsForAgent,
  type ModelProviderConfig,
  type RuntimeAssetSnapshot
} from "@vivd-catalyst/core";
import type { AgentConfig, ClientInstanceConfig } from "./schemas";
import { createClientBranding, isPasswordMailEnabled } from "./branding";
import { getModelSelectionForAgent } from "./selectors";
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
  const {
    environment: _environment,
    passwordResetEnabled: _passwordResetEnabled,
    ...ui
  } = createClientBranding(config, {
    requestedLocale: locale
  });

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
      resources: {
        enabled: config.ui.resources.enabled
      },
      collaborationWorkspaces: {
        enabled: config.ui.collaborationWorkspaces.enabled
      },
      configAssets: {
        ...config.administration.agentConfiguration
      },
      userInvitations: {
        enabled: isPasswordMailEnabled(config)
      }
    },
    defaultAgentName: assets.defaultAgentName,
    agents: assets.agents.map((agent) => ({
      name: agent.name,
      displayName: resolveLocalizedString(
        agent.displayName,
        locale,
        config.localization.defaultLocale
      ),
      description: resolveLocalizedString(
        agent.description,
        locale,
        config.localization.defaultLocale
      ),
      ...compactionThresholdView(getModelSelectionForAgent(config, agent).provider),
      ...(agent.modelBindingId ? { defaultModelBindingId: agent.modelBindingId } : {}),
      selectableModels: agentSelectableModels(config, agent),
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
        title: resolveLocalizedString(
          initialPrompt.title,
          locale,
          config.localization.defaultLocale
        ),
        prompt: resolveLocalizedString(
          initialPrompt.prompt,
          locale,
          config.localization.defaultLocale
        )
      }))
    })),
    ui
  };
}

/** The agent's own model first, then the bindings users may pick instead. */
function agentSelectableModels(config: ClientInstanceConfig, agent: AgentConfig) {
  const own = getModelSelectionForAgent(config, agent);
  return [
    {
      ...(agent.modelBindingId ? { bindingId: agent.modelBindingId } : {}),
      model: own.model,
      ...compactionThresholdView(own.provider)
    },
    ...userSelectableModelBindingsForAgent(agent, config.modelBindings).map((binding) =>
      bindingModelView(config, binding)
    )
  ];
}

function bindingModelView(
  config: ClientInstanceConfig,
  binding: ClientInstanceConfig["modelBindings"][number]
) {
  const provider = config.modelProviders.find((candidate) => candidate.id === binding.providerId)!;
  return {
    bindingId: binding.id,
    model: binding.model ?? provider.model,
    ...compactionThresholdView(provider)
  };
}

function compactionThresholdView(provider: ModelProviderConfig): {
  compactThresholdTokens?: number;
} {
  const compactThresholdTokens =
    provider.type === "openai-compatible"
      ? provider.contextManagement?.compaction?.compactThresholdTokens
      : undefined;
  return compactThresholdTokens === undefined ? {} : { compactThresholdTokens };
}
