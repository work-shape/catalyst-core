import {
  agentSelectableModelViews,
  getModelSelectionForAgent,
  resolveLocalizedString,
  resolveModelBinding,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import {
  ALL_SUBAGENTS,
  RUN_AGENT_LISTED_AGENTS_MAX,
  type AgentConfig,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type CollaborationWorkspaceId,
  type ConversationId,
  type LocaleCode,
  type RuntimeAssetSnapshot,
  type SubagentAgentChoice,
  type SubagentChoices,
  type SubagentModelChoice
} from "@work-shape/catalyst-core";

// What a run may start as a subagent (CR-3m): the agents and the models its `run_agent` tool
// lists, and what `agents.run` checks each call against. Both read from here, so the tool
// never offers what the call refuses, and the models come from the chat's model picker.

/**
 * Whether a person may use an agent in a workspace now: the rule a new run starts under,
 * availability and `agent.use` (AGENT-USE-1). With a correlation id a refusal of `agent.use`
 * is recorded. With the root chat, the actor's own agent ("Nur ich") counts as available in a
 * chat only they read.
 */
export type SubagentAgentAvailable = (input: {
  agentName: string;
  workspaceId: CollaborationWorkspaceId;
  actor: AuthenticatedIdentity;
  correlationId?: string;
  conversationId?: ConversationId;
  /**
   * The chat the call is made from, its root for a subagent's thread. A person who reads it
   * from outside its workspace (`readsChatFromOutside`) runs only the instance's agents there.
   */
  chatId?: ConversationId;
}) => Promise<boolean>;

export interface SubagentChoiceOptions {
  clientInstanceId: ClientInstanceId;
  config: ClientInstanceConfig;
  /** Where the model list of the workspace that owns an agent is read. */
  stores: {
    workspaces: {
      getWorkspace(
        clientInstanceId: ClientInstanceId,
        workspaceId: CollaborationWorkspaceId
      ): Promise<{ allowedModelBindingIds?: string[] } | undefined>;
    };
  };
  agentAvailable: SubagentAgentAvailable;
}

/** The chat a parent run works in: the root its subagents' threads belong to. */
interface RootChat {
  id: ConversationId;
  collaborationWorkspaceId: CollaborationWorkspaceId;
}

/**
 * Whether the parent's agent may name this agent as a subagent (Q3): itself, an agent its
 * `subagentNames` lists, or any agent where it lists `"*"`. The person's rights decide apart.
 */
export function listsSubagent(
  parent: Pick<AgentConfig, "subagentNames"> | undefined,
  parentAgentName: string,
  agentName: string
): boolean {
  return (
    agentName === parentAgentName ||
    parent?.subagentNames === ALL_SUBAGENTS ||
    (parent?.subagentNames ?? []).includes(agentName)
  );
}

/**
 * Whether the person may run this agent as a subagent in the root chat now. Its own agent
 * is judged by the chat's audience, as a person's own agent that runs itself there.
 */
export function subagentAvailable(
  options: Pick<SubagentChoiceOptions, "agentAvailable">,
  input: {
    agentName: string;
    parentAgentName: string;
    root: RootChat;
    actor: AuthenticatedIdentity;
    correlationId?: string;
  }
): Promise<boolean> {
  return options.agentAvailable({
    agentName: input.agentName,
    workspaceId: input.root.collaborationWorkspaceId,
    actor: input.actor,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    // The subagent's thread belongs to this chat, so a person's own agent that runs itself
    // there is judged by the chat's audience. Another agent it names never is.
    ...(input.agentName === input.parentAgentName ? { conversationId: input.root.id } : {}),
    chatId: input.root.id
  });
}

/**
 * The models a person may pick on an agent run as a subagent: those the chat's model picker
 * offers for it that have a binding, narrowed by the model list of the workspace that owns
 * the agent, as a run's fallback is (FALLBACK-1). An agent of the instance is narrowed by none.
 */
export async function subagentModelChoices(
  options: Pick<SubagentChoiceOptions, "clientInstanceId" | "config" | "stores">,
  assets: Pick<RuntimeAssetSnapshot, "agentKeys">,
  agent: AgentConfig,
  locale?: LocaleCode
): Promise<SubagentModelChoice[]> {
  const scope = assets.agentKeys?.get(agent.name)?.scope;
  const allowed =
    scope?.kind === "workspace"
      ? (await options.stores.workspaces.getWorkspace(options.clientInstanceId, scope.workspaceId))
          ?.allowedModelBindingIds
      : undefined;
  return agentSelectableModelViews(
    options.config,
    agent,
    locale === undefined ? {} : { requestedLocale: locale }
  )
    .flatMap((view): SubagentModelChoice[] =>
      view.bindingId === undefined || (allowed !== undefined && !allowed.includes(view.bindingId))
        ? []
        : [
            {
              bindingId: view.bindingId,
              label: view.label ?? view.model,
              ...(view.description === undefined ? {} : { description: view.description }),
              ...(view.usageTier === undefined ? {} : { usageTier: view.usageTier })
            }
          ]
    )
    .sort((left, right) => compareIds(left.bindingId, right.bindingId));
}

/**
 * What a run's `run_agent` tool lists: the parent's own agent and the agents it names, each
 * only where the person may use it in the root chat now, with the models the person may pick
 * on each. Sorted stably, the parent's own agent first, so the tool's definition changes only
 * when config or rights do. At most `RUN_AGENT_LISTED_AGENTS_MAX` agents.
 */
export async function subagentChoices(
  options: SubagentChoiceOptions,
  input: {
    assets: Pick<RuntimeAssetSnapshot, "agents" | "agentKeys">;
    parentAgentName: string;
    root: RootChat;
    actor: AuthenticatedIdentity;
    locale?: LocaleCode;
  }
): Promise<SubagentChoices> {
  const { assets, parentAgentName } = input;
  const parent = assets.agents.find((agent) => agent.name === parentAgentName);
  const candidates = assets.agents
    .filter((agent) => listsSubagent(parent, parentAgentName, agent.name))
    .sort((left, right) =>
      left.name === parentAgentName
        ? -1
        : right.name === parentAgentName
          ? 1
          : compareIds(left.name, right.name)
    );
  const available = (
    await Promise.all(
      candidates.map(async (agent) =>
        (await subagentAvailable(options, { ...input, agentName: agent.name })) ? [agent] : []
      )
    )
  ).flat();
  const listed = available.slice(0, RUN_AGENT_LISTED_AGENTS_MAX);
  const locale = input.locale ?? options.config.localization.defaultLocale;
  const models = new Map<string, SubagentModelChoice>();
  const agents = await Promise.all(
    listed.map(async (agent): Promise<SubagentAgentChoice> => {
      const offered = await subagentModelChoices(options, assets, agent, locale);
      for (const model of offered) models.set(model.bindingId, model);
      const description = firstLine(
        resolveLocalizedString(agent.description, locale, options.config.localization.defaultLocale)
      );
      return {
        name: agent.name,
        displayName: resolveLocalizedString(
          agent.displayName,
          locale,
          options.config.localization.defaultLocale
        ),
        ...(description === undefined ? {} : { description }),
        modelBindingIds: offered.map((model) => model.bindingId)
      };
    })
  );
  return {
    ownAgentName: parentAgentName,
    agents,
    models: [...models.values()].sort((left, right) => compareIds(left.bindingId, right.bindingId)),
    moreAgents: available.length > listed.length
  };
}

/** The most characters of an agent's description its line in the tool carries. */
const AGENT_LINE_MAX = 200;

function firstLine(text: string | undefined): string | undefined {
  const line = text?.trim().split("\n")[0]?.trim();
  if (!line) return undefined;
  return line.length > AGENT_LINE_MAX ? `${line.slice(0, AGENT_LINE_MAX - 1)}…` : line;
}

/** An order of ids that no locale changes. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** How a person reads a subagent: its agent's display name and its model (CR-3m). */
export interface SubagentNaming {
  agentDisplayName: string;
  model?: { model: string; label?: string };
}

/**
 * The agent's display name in the reader's locale and the model a subagent runs on, for its
 * card, its row in the Resources panel and its thread's head: never the technical name, except
 * for an agent that no longer exists. The model is the run's binding, else its agent's own.
 */
export function nameSubagent(
  config: ClientInstanceConfig,
  assets: Pick<RuntimeAssetSnapshot, "agents">,
  subagent: { agentName: string; modelBindingId?: string },
  locale: LocaleCode
): SubagentNaming {
  const agent = assets.agents.find((candidate) => candidate.name === subagent.agentName);
  const bindingId = subagent.modelBindingId ?? agent?.modelBindingId;
  const binding = config.modelBindings.find((candidate) => candidate.id === bindingId);
  const model = binding
    ? { model: resolveModelBinding(config, binding.id).model, label: binding.label }
    : agent
      ? { model: getModelSelectionForAgent(config, agent).model }
      : undefined;
  return {
    agentDisplayName: agent
      ? resolveLocalizedString(agent.displayName, locale, config.localization.defaultLocale)
      : subagent.agentName,
    ...(model
      ? {
          model: {
            model: model.model,
            ...(model.label === undefined ? {} : { label: model.label })
          }
        }
      : {})
  };
}
