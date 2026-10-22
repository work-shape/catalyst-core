import { OPERATION_EFFECTS } from "@work-shape/catalyst-asset-schemas";
import {
  AGENT_STARTERS_MAX,
  SUBJECT_TOOL_PREFIX,
  authorReasoningEffort,
  defaultReasoningEffortForAgentBinding,
  modelUsageTierFromRates,
  reasoningEffortChoiceForBinding,
  reasoningEffortsOffered,
  userSelectableModelBindingsForAgent,
  type LocaleCode,
  type LocalizedStringConfig,
  type ModelBindingConfig,
  type ModelProviderConfig,
  type ModuleSnapshot,
  type ReasoningEffortConfig,
  type RuntimeAssetSnapshot,
  type SkillConfig
} from "@work-shape/catalyst-core";
import { createClientBranding } from "./branding";
import {
  resolveConfigLocale,
  resolveLocalizedString,
  type ConfigLocaleInput
} from "./localization";
import type { AgentConfig, ClientInstanceConfig } from "./schemas";
import { getModelSelectionForAgent, resolveModelBinding } from "./selectors";

/** The tool that saves and creates assets: an agent that lists it builds them. */
const ASSET_PUT_TOOL = `${SUBJECT_TOOL_PREFIX}put`;

export interface SafeConfigViewOptions extends ConfigLocaleInput {
  /**
   * The reasoning efforts the model behind a binding takes, as the instance's model gateway
   * reports them. Left out, a binding offers only the efforts it lists itself.
   */
  reasoningEffortsOfBinding?: (bindingId: string) => readonly ReasoningEffortConfig[];
  /**
   * The Connections of the instance with the tools an agent can carry. Each agent is told
   * those its own tools reach. Left out, no agent names a Connection.
   */
  connections?: readonly SafeConfigConnection[];
  /**
   * Whether the reader may write the agent of this name. A reader who may not is offered a
   * reasoning effort only where the agent's author left it open: the efforts a model binding
   * allows are no choice by themselves (UX audit, ruling 4). Left out, every reader is offered
   * what a writer is.
   */
  mayWriteAgent?: (agentName: string) => boolean;
}

/** One Connection as a conversation names it: what a tool call touched, and its icon. */
export interface SafeConfigConnection {
  name: string;
  title: string;
  service?: string;
  connectorType?: string;
  tools: readonly { toolName: string; effect: (typeof OPERATION_EFFECTS)[number] }[];
}

export function createSafeConfigView(
  config: ClientInstanceConfig,
  assets: RuntimeAssetSnapshot,
  modules: ModuleSnapshot,
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
    replies: {
      allowedLinkHosts: config.replies.allowedLinkHosts
    },
    modules: Object.fromEntries(
      modules.modules.map((module) => [module.name, { enabled: module.enabled }])
    ),
    feedback: { exchangeSnapshot: config.feedback.exchangeSnapshot },
    // Derived from the modules for one transition release; the interface moves to `modules`.
    features: {
      attachments: {
        enabled: false,
        accept: ""
      },
      resources: {
        enabled: modules.isEnabled("resources")
      },
      configAssets: {
        ...config.administration.agentConfiguration,
        enabled: modules.isEnabled("assetManagement")
      },
      userInvitations: {
        enabled: modules.isEnabled("userInvitations")
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
      selectableModels: agentSelectableModels(
        models,
        agent,
        options.mayWriteAgent?.(agent.name) ?? true
      ),
      ...(agent.toolNames.includes(ASSET_PUT_TOOL) ? { buildsAssets: true } : {}),
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
      // The author's prompts and the skills' starters share the start page's four places,
      // the author's prompts first.
      initialPrompts: agent.initialPrompts.slice(0, AGENT_STARTERS_MAX).map((initialPrompt) => ({
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
      })),
      starters: agentStarters(
        agent,
        assets.skills,
        locale,
        config.localization.defaultLocale
      ).slice(0, Math.max(0, AGENT_STARTERS_MAX - agent.initialPrompts.length)),
      connections: agentConnections(agent, options.connections ?? [])
    })),
    ui
  };
}

/** The Connections an agent's tools reach, each with the tools of it the agent holds. */
function agentConnections(agent: AgentConfig, connections: readonly SafeConfigConnection[]) {
  return connections.flatMap(({ name, title, service, connectorType, tools }) => {
    const held = tools
      .filter((tool) => agent.toolNames.includes(tool.toolName))
      .map(({ toolName, effect }) => ({ toolName, effect }));
    return held.length === 0
      ? []
      : [
          {
            name,
            title,
            ...(service === undefined ? {} : { service }),
            ...(connectorType === undefined ? {} : { connectorType }),
            tools: held
          }
        ];
  });
}

/**
 * The starters the empty chat offers for an agent: those of its skills, the skills in the
 * order the agent names them, at most `AGENT_STARTERS_MAX`. The author's own prompts take
 * places of these first. A starter that names a tool the
 * agent does not hold is left out, so none offers what the agent cannot do. A starter carries
 * its skill's icon only where the skill ships with the platform; every other skill's starter
 * shows the generic skill icon.
 */
function agentStarters(
  agent: AgentConfig,
  skills: readonly SkillConfig[],
  locale: LocaleCode,
  defaultLocale: LocaleCode
) {
  const text = (value: LocalizedStringConfig) =>
    resolveLocalizedString(value, locale, defaultLocale);
  return agent.skillNames
    .flatMap((skillName) => {
      const skill = skills.find((candidate) => candidate.name === skillName);
      const icon = skill?.origin === "release" ? skill.icon : undefined;
      return (skill?.starters ?? [])
        .filter((starter) => (starter.tools ?? []).every((tool) => agent.toolNames.includes(tool)))
        .map((starter) => ({
          skillName,
          title: text(starter.title),
          ...(starter.hint === undefined ? {} : { hint: text(starter.hint) }),
          prompt: text(starter.prompt),
          ...(icon === undefined ? {} : { icon })
        }));
    })
    .slice(0, AGENT_STARTERS_MAX);
}

/**
 * The agent's own model first, then the bindings users may pick instead. For a reader who may
 * not write the agent, a model whose effort the author set offers no other effort, so the
 * composer shows no model control where the author offered no choice.
 */
function agentSelectableModels(context: ModelViewContext, agent: AgentConfig, writer: boolean) {
  const { config } = context;
  const own = getModelSelectionForAgent(config, agent);
  const offered = <View extends { selectableReasoningEfforts: ReasoningEffortConfig[] }>(
    view: View,
    bindingId: string | undefined
  ): View => ({
    ...view,
    selectableReasoningEfforts: reasoningEffortsOffered(
      view.selectableReasoningEfforts,
      authorReasoningEffort(agent, bindingId),
      writer
    )
  });
  const bindingView = (binding: ModelBindingConfig) => {
    const selection = resolveModelBinding(config, binding.id);
    return offered(
      modelView(context, {
        provider: selection.provider,
        binding,
        model: selection.model,
        reasoningEffort:
          defaultReasoningEffortForAgentBinding(agent, binding) ?? selection.reasoningEffort
      }),
      binding.id
    );
  };
  const bindings = userSelectableModelBindingsForAgent(agent, config.modelBindings);
  // An agent on its provider's own model that also lists a binding for that same model offers
  // it once, as that binding: picking it runs exactly as picking the binding did.
  const ownBinding =
    agent.modelBindingId === undefined
      ? bindings.find((binding) => {
          const selection = resolveModelBinding(config, binding.id);
          return selection.provider.id === own.provider.id && selection.model === own.model;
        })
      : undefined;
  return [
    ownBinding
      ? bindingView(ownBinding)
      : offered(
          modelView(context, {
            provider: own.provider,
            binding: own.binding,
            model: own.model,
            reasoningEffort: own.reasoningEffort
          }),
          agent.modelBindingId
        ),
    ...bindings.filter((binding) => binding !== ownBinding).map(bindingView)
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
    ...(binding?.label ? { label: binding.label } : {}),
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
