import {
  defaultReasoningEffortForAgentBinding,
  modelUsageTierFromRates,
  userSelectableModelBindingsForAgent,
  userSelectableReasoningEffortsForBinding,
  type LocaleCode,
  type ModelBindingConfig,
  type ModelProviderConfig,
  type ReasoningEffortConfig,
  type RuntimeAssetSnapshot
} from "@vivd-catalyst/core";
import type { AgentConfig, ClientInstanceConfig } from "./schemas";
import { createClientBranding, isPasswordMailEnabled } from "./branding";
import { getModelSelectionForAgent, resolveModelBinding } from "./selectors";
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
      selectableModels: agentSelectableModels(config, agent, locale),
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
function agentSelectableModels(
  config: ClientInstanceConfig,
  agent: AgentConfig,
  locale: LocaleCode
) {
  const own = getModelSelectionForAgent(config, agent);
  return [
    modelView(config, locale, {
      provider: own.provider,
      binding: own.binding,
      model: own.model,
      reasoningEffort: own.reasoningEffort
    }),
    ...userSelectableModelBindingsForAgent(agent, config.modelBindings).map((binding) => {
      const selection = resolveModelBinding(config, binding.id);
      return modelView(config, locale, {
        provider: selection.provider,
        binding,
        model: selection.model,
        reasoningEffort:
          defaultReasoningEffortForAgentBinding(agent, binding) ?? selection.reasoningEffort
      });
    })
  ];
}

/** What the model picker shows for one model: who makes it, where it runs and what it costs. */
function modelView(
  config: ClientInstanceConfig,
  locale: LocaleCode,
  selection: {
    provider: ModelProviderConfig;
    binding: ModelBindingConfig | undefined;
    model: string;
    reasoningEffort: ReasoningEffortConfig | undefined;
  }
) {
  const { provider, binding, model, reasoningEffort } = selection;
  const description = binding?.description
    ? resolveLocalizedString(binding.description, locale, config.localization.defaultLocale)
    : undefined;
  const residency =
    provider.type === "openai-compatible" ? provider.compliance?.residency : undefined;
  const rates = config.usage.costs.customer?.models.find(
    (candidate) => candidate.providerId === provider.id && candidate.model === model
  );
  const usageTier = binding?.usageTier ?? (rates ? modelUsageTierFromRates(rates) : undefined);
  return {
    ...(binding ? { bindingId: binding.id } : {}),
    model,
    ...compactionThresholdView(provider),
    ...(binding?.vendor ? { vendor: binding.vendor } : {}),
    ...(description ? { description } : {}),
    ...(residency ? { residency } : {}),
    ...(usageTier ? { usageTier } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    selectableReasoningEfforts: userSelectableReasoningEffortsForBinding(binding, reasoningEffort)
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
