import {
  defaultReasoningEffortForAgentBinding,
  modelUsageTierFromRates,
  reasoningEffortChoiceForBinding,
  userSelectableModelBindingsForAgent,
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

export interface SafeConfigViewOptions extends ConfigLocaleInput {
  /**
   * The reasoning efforts the model behind a binding takes, as the instance's model gateway
   * reports them. Left out, a binding offers only the efforts it lists itself.
   */
  reasoningEffortsOfBinding?: (bindingId: string) => readonly ReasoningEffortConfig[];
}

export function createSafeConfigView(
  config: ClientInstanceConfig,
  assets: RuntimeAssetSnapshot,
  options: SafeConfigViewOptions = {}
) {
  const locale = resolveConfigLocale(config.localization, options);
  const models: ModelViewContext = {
    config,
    locale,
    reasoningEffortsOfBinding: options.reasoningEffortsOfBinding ?? (() => [])
  };
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
    views: {
      allowedScriptSrc: config.views.allowedScriptSrc
    },
    features: {
      attachments: {
        enabled: false,
        accept: ""
      },
      resources: {
        enabled: config.ui.resources.enabled
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
      selectableModels: agentSelectableModels(models, agent),
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
function agentSelectableModels(context: ModelViewContext, agent: AgentConfig) {
  const { config } = context;
  const own = getModelSelectionForAgent(config, agent);
  return [
    modelView(context, {
      provider: own.provider,
      binding: own.binding,
      model: own.model,
      reasoningEffort: own.reasoningEffort
    }),
    ...userSelectableModelBindingsForAgent(agent, config.modelBindings).map((binding) => {
      const selection = resolveModelBinding(config, binding.id);
      return modelView(context, {
        provider: selection.provider,
        binding,
        model: selection.model,
        reasoningEffort:
          defaultReasoningEffortForAgentBinding(agent, binding) ?? selection.reasoningEffort
      });
    })
  ];
}

interface ModelViewContext {
  config: ClientInstanceConfig;
  locale: LocaleCode;
  reasoningEffortsOfBinding: (bindingId: string) => readonly ReasoningEffortConfig[];
}

/** What the model picker shows for one model: who makes it, where it runs and what it costs. */
function modelView(
  { config, locale, reasoningEffortsOfBinding }: ModelViewContext,
  selection: {
    provider: ModelProviderConfig;
    binding: ModelBindingConfig | undefined;
    model: string;
    reasoningEffort: ReasoningEffortConfig | undefined;
  }
) {
  const { provider, binding, model } = selection;
  const description = binding?.description
    ? resolveLocalizedString(binding.description, locale, config.localization.defaultLocale)
    : undefined;
  const rates = config.usage.costs.customer?.models.find(
    (candidate) => candidate.providerId === provider.id && candidate.model === model
  );
  const usageTier = binding?.usageTier ?? (rates ? modelUsageTierFromRates(rates) : undefined);
  const reasoning = reasoningEffortChoiceForBinding(
    binding,
    binding ? reasoningEffortsOfBinding(binding.id) : [],
    selection.reasoningEffort
  );
  return {
    ...(binding ? { bindingId: binding.id } : {}),
    model,
    ...compactionThresholdView(provider),
    ...(binding?.vendor ? { vendor: binding.vendor } : {}),
    ...(description ? { description } : {}),
    ...(provider.region ? { region: provider.region } : {}),
    ...(usageTier ? { usageTier } : {}),
    ...(reasoning.defaultEffort ? { reasoningEffort: reasoning.defaultEffort } : {}),
    selectableReasoningEfforts: reasoning.selectable
  };
}

function compactionThresholdView(provider: ModelProviderConfig): {
  compactThresholdTokens?: number;
} {
  const compactThresholdTokens = provider.contextManagement?.compaction?.compactThresholdTokens;
  return compactThresholdTokens === undefined ? {} : { compactThresholdTokens };
}
