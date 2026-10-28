import { resolveLocalizedString } from "@work-shape/catalyst-config-schema";
import {
  AppError,
  asCollaborationWorkspaceId,
  asConversationId,
  asUserId,
  auditActorFromUser,
  getSubjectUserId,
  isAppError,
  isAgentAvailableInWorkspace,
  isAuthenticatedServicePrincipal,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  ownerReachRefusal,
  PROJECT_ASSET_KIND,
  PROJECT_CHOICE_REFUSALS,
  PROJECT_KNOWLEDGE_BASES_MAX,
  PROJECT_SKILLS_MAX,
  projectDefinitionSchema,
  projectReadOnlyBy,
  createAuthorizer,
  type ActorAccess,
  type AgentAvailability,
  type AgentConfig,
  type AssetScope,
  type ConfigAssetRecord,
  type AuditRecorder,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type LocaleCode,
  type Project,
  type ProjectChoiceKind,
  type ProjectRunKnowledgeBases,
  type ProjectRunSkills,
  type ProjectSkillsPort
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { accessResource } from "../assets/asset-access";
import {
  callerAccess,
  getWorkspaceAssetSnapshot,
  ownAgents
} from "../workspaces/agent-availability";
import {
  projectNotAvailable,
  requireProjectAccess,
  requireProjectReadable
} from "./project-access";

// A project's default agent and attached skills (PRJ-7). The one rule of who may rely on what
// (`ownerReachRefusal`) holds here too: something others read never relies on what is a
// person's own. A project others read offers the agents of its workspace and the skills its
// workspace owns or its agents use; a project only its creator reads offers their own agents
// and skills as well, and a chat that uses one is marked personal, as their own chats are.

/** How many skills of the workspace a project's chooser reads. */
const WORKSPACE_SKILLS_READ = 200;

// A project's Knowledge Bases (PRJ-8). Attaching grants nothing: each search asks the person's
// `knowledge_base.use`. What may be attached is what every reader of the project's chats may
// search, as a chat's answers from it stand in the transcript for all of them: in a project
// others read, a Knowledge Base available in its workspace, which gives every member the use;
// in one only its creator reads, any they may search, their own among them. The candidates are
// those an agent of the workspace could name (`ownerReachRefusal`), and the person's own.

/** How many Knowledge Bases of each owner a project's chooser reads. */
const KNOWLEDGE_BASES_READ = 200;

export type ProjectSetupOptions = Pick<
  ChatServerOptions,
  "stores" | "clientInstanceId" | "config" | "modules"
> &
  Partial<Pick<ChatServerOptions, "authorizer">> & {
    configAssets: Pick<ChatServerOptions["configAssets"], "source" | "store">;
  };

/**
 * Why a choice is greyed: the person's own, in a project others read; or a Knowledge Base not
 * everyone in the project's audience may search.
 */
type ProjectChoiceRefusal = (typeof PROJECT_CHOICE_REFUSALS)[number];

interface ProjectChoiceAsset {
  id: string;
  workspaceId: string;
}

interface ProjectAgentChoice {
  name: string;
  displayName: string;
  description?: string;
  own: boolean;
  refusal?: ProjectChoiceRefusal;
  asset?: ProjectChoiceAsset;
}

interface ProjectSkillChoice {
  name: string;
  title: string;
  summary?: string;
  icon?: string;
  own: boolean;
  refusal?: ProjectChoiceRefusal;
  asset?: ProjectChoiceAsset;
}

interface ProjectKnowledgeBaseChoice {
  name: string;
  title: string;
  description?: string;
  unpublished?: boolean;
  own: boolean;
  refusal?: ProjectChoiceRefusal;
  asset?: ProjectChoiceAsset;
}

export interface ProjectSetup {
  defaultAgent?: string;
  skills: string[];
  workspaceDefaultAgent?: string;
  agents: ProjectAgentChoice[];
  skillChoices: ProjectSkillChoice[];
  knowledgeBases: string[];
  knowledgeBaseChoices?: ProjectKnowledgeBaseChoice[];
}

/** What decides the Knowledge Bases of one project for one person. */
interface KnowledgeScope {
  project: Project;
  workspace: CollaborationWorkspace;
  person: string;
  /** The person's rights as a call in a chat of the project asks them: in its workspace. */
  access: ActorAccess;
  /** Only the person reads the project and its chats. */
  alone: boolean;
  availability: Map<string, AgentAvailability>;
  ownerOf(workspaceId: string): Promise<CollaborationWorkspace | undefined>;
}

/** What the person may choose for a project now, and what a chat of theirs in it reads. */
interface ProjectChoices {
  workspaceDefaultAgent?: string;
  agents: ProjectAgentChoice[];
  skills: ProjectSkillChoice[];
}

export class ProjectSetupService implements ProjectSkillsPort {
  constructor(private readonly options: ProjectSetupOptions) {}

  private async workspaceOf(project: Project): Promise<CollaborationWorkspace> {
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      project.collaborationWorkspaceId
    );
    if (!workspace) throw projectNotAvailable();
    return workspace;
  }

  /**
   * The agents and skills the person may choose for the project: those of its workspace for
   * everyone in its audience, and the person's own, greyed where others read the project.
   */
  private async choicesFor(
    user: AuthenticatedUser,
    project: Project,
    locale?: LocaleCode
  ): Promise<ProjectChoices> {
    const { options } = this;
    const person = getSubjectUserId(user);
    const workspace = await this.workspaceOf(project);
    const access = await callerAccess(options, user);
    const assets = await getWorkspaceAssetSnapshot(options, workspace, access);
    const alone = projectReadOnlyBy(project, workspace, person);
    const refusal = alone ? undefined : ("own_in_shared_project" as const);
    const fallback = options.config.localization.defaultLocale;
    const shown = locale ?? fallback;
    const agentView = (agent: AgentConfig) => {
      const description = resolveLocalizedString(agent.description, shown, fallback);
      return {
        name: agent.name,
        displayName: resolveLocalizedString(agent.displayName, shown, fallback),
        ...(description ? { description } : {})
      };
    };
    const offered = new Set(assets.agents.map((agent) => agent.name));
    const own = (await ownAgents(options, { user, access })).filter(
      (agent) => !offered.has(agent.name)
    );
    const agents: ProjectAgentChoice[] = [
      ...assets.agents.map((agent) => ({ ...agentView(agent), own: false })),
      ...own.map((agent) => {
        const key = assets.agentKeys?.get(agent.name);
        return {
          ...agentView(agent),
          own: true,
          ...(refusal ? { refusal } : {}),
          ...(key?.scope.kind === "workspace"
            ? { asset: { id: key.id, workspaceId: key.scope.workspaceId } }
            : {})
        };
      })
    ];

    // The skills: the workspace's own, those of the agents offered here, and the person's own.
    const workspaceSkills =
      workspace.kind === "shared"
        ? await options.stores.configAssets.listConfigAssetPage({
            clientInstanceId: options.clientInstanceId,
            kind: "skill",
            scope: { kind: "workspace", workspaceId: workspace.id },
            limit: WORKSPACE_SKILLS_READ,
            readable: () => true
          })
        : [];
    const personal = await options.stores.configAssets.listPersonalChatSkills({
      clientInstanceId: options.clientInstanceId,
      userId: person
    });
    const names = new Set([
      ...workspaceSkills.map((skill) => skill.name),
      ...assets.agents.flatMap((agent) => agent.skillNames ?? []),
      ...personal.map((skill) => skill.name)
    ]);
    const records = await options.stores.configAssets.listConfigAssetsByKey({
      clientInstanceId: options.clientInstanceId,
      keys: [...names].map((name) => ({ kind: "skill", name }))
    });
    const owners = new Map<string, Promise<CollaborationWorkspace | undefined>>();
    const ownerOf = (workspaceId: string) => {
      let owner = owners.get(workspaceId);
      if (owner === undefined) {
        owner = options.stores.workspaces.getWorkspace(
          options.clientInstanceId,
          asCollaborationWorkspaceId(workspaceId)
        );
        owners.set(workspaceId, owner);
      }
      return owner;
    };
    const live = new Map(assets.skills.map((skill) => [skill.name, skill]));
    const skills: ProjectSkillChoice[] = [];
    for (const record of records) {
      const skill = live.get(record.name);
      if (record.status !== "active" || !skill) continue;
      const owner =
        record.scope.kind === "workspace" ? await ownerOf(record.scope.workspaceId) : undefined;
      // A skill of a Personal Workspace is its person's own: nobody else's is ever offered.
      const ownSkill = owner !== undefined && owner.kind === "personal";
      if (ownSkill && owner.personalUserId !== person) continue;
      skills.push({
        name: skill.name,
        title: skill.title || skill.name,
        ...(skill.summary ? { summary: skill.summary } : {}),
        ...(skill.origin === "release" && skill.icon ? { icon: skill.icon } : {}),
        own: ownSkill,
        ...(ownSkill && refusal ? { refusal } : {}),
        ...(ownSkill && record.scope.kind === "workspace"
          ? { asset: { id: record.id, workspaceId: record.scope.workspaceId } }
          : {})
      });
    }
    skills.sort((left, right) => left.title.localeCompare(right.title, shown));
    return {
      ...(assets.defaultAgentName ? { workspaceDefaultAgent: assets.defaultAgentName } : {}),
      agents,
      skills
    };
  }

  /** A project's default agent and skills, with what the caller may choose for it. */
  async setup(user: AuthenticatedUser, projectId: string, locale?: LocaleCode) {
    const project = await requireProjectAccess(this.options, user, projectId);
    const [choices, knowledgeBases] = await Promise.all([
      this.choicesFor(user, project, locale),
      this.knowledgeChoicesFor(user, project, locale)
    ]);
    return this.viewOf(project, choices, knowledgeBases);
  }

  private viewOf(
    project: Project,
    choices: ProjectChoices,
    knowledgeBases: ProjectKnowledgeBaseChoice[] | undefined
  ): ProjectSetup {
    return {
      ...(project.defaultAgent ? { defaultAgent: project.defaultAgent } : {}),
      skills: project.skills ?? [],
      ...(choices.workspaceDefaultAgent
        ? { workspaceDefaultAgent: choices.workspaceDefaultAgent }
        : {}),
      agents: choices.agents,
      skillChoices: choices.skills,
      knowledgeBases: project.knowledgeBases ?? [],
      ...(knowledgeBases ? { knowledgeBaseChoices: knowledgeBases } : {})
    };
  }

  /** What decides the person's Knowledge Bases in the project; nothing where the module is off. */
  private async knowledgeScope(
    user: AuthenticatedUser,
    project: Project
  ): Promise<KnowledgeScope | undefined> {
    const { options } = this;
    if (!options.modules.isEnabled("knowledge")) return undefined;
    const person = getSubjectUserId(user);
    const workspace = await this.workspaceOf(project);
    const [access, availability] = await Promise.all([
      (options.authorizer ?? createAuthorizer(options.stores.access)).forActor(user, {
        workspaceId: project.collaborationWorkspaceId
      }),
      options.configAssets.store.listAgentAvailability({
        clientInstanceId: options.clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND
      })
    ]);
    const owners = new Map<string, Promise<CollaborationWorkspace | undefined>>([
      [workspace.id, Promise.resolve(workspace)]
    ]);
    return {
      project,
      workspace,
      person,
      access,
      alone: projectReadOnlyBy(project, workspace, person),
      availability,
      ownerOf: (workspaceId) => {
        let owner = owners.get(workspaceId);
        if (owner === undefined) {
          owner = options.stores.workspaces.getWorkspace(
            options.clientInstanceId,
            asCollaborationWorkspaceId(workspaceId)
          );
          owners.set(workspaceId, owner);
        }
        return owner;
      }
    };
  }

  /**
   * One Knowledge Base as the person may attach it to the project, greyed with the reason where
   * not everyone in its audience may search it; nothing where the person may not search it, it
   * is another person's own, or one an agent of the workspace could not name.
   */
  private async knowledgeChoiceOf(
    scope: KnowledgeScope,
    record: ConfigAssetRecord
  ): Promise<ProjectKnowledgeBaseChoice | undefined> {
    if (record.status !== "active" || record.kind !== KNOWLEDGE_BASE_ASSET_KIND) return undefined;
    const owner =
      record.scope.kind === "workspace" ? await scope.ownerOf(record.scope.workspaceId) : undefined;
    if (record.scope.kind === "workspace" && owner === undefined) return undefined;
    const own = owner?.kind === "personal";
    if (own && owner.personalUserId !== scope.person) return undefined;
    // Beside the person's own, what an agent of the project's workspace could name.
    if (
      !own &&
      ownerReachRefusal(
        {
          kind: "workspace",
          workspaceId: scope.workspace.id,
          workspaceKind: scope.workspace.kind
        },
        {
          kind: "reference",
          target:
            record.scope.kind === "workspace"
              ? {
                  kind: "workspace",
                  workspaceId: record.scope.workspaceId,
                  workspaceKind: owner?.kind
                }
              : { kind: "instance" }
        }
      ) !== undefined
    ) {
      return undefined;
    }
    const resource = accessResource(record.kind, record.name, record.scope, record.id);
    if (!scope.access.authorize(KNOWLEDGE_BASE_ACTIONS.use, resource).allowed) return undefined;
    // Where others read the project: the person's own reaches no chat of theirs, and another
    // only where every member of the workspace may search it, as its availability there gives.
    const refusal: ProjectChoiceRefusal | undefined = scope.alone
      ? undefined
      : own
        ? ownerReachRefusal(
            { kind: "workspace", workspaceId: owner.id, workspaceKind: owner.kind },
            { kind: "conversation", workspaceId: scope.workspace.id }
          ) === undefined
          ? undefined
          : "own_in_shared_project"
        : isAgentAvailableInWorkspace(scope.availability.get(record.name), scope.workspace)
          ? undefined
          : "not_everyone_may_use";
    const config = record.publishedConfig ?? record.config ?? {};
    const text = (value: unknown) =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    const title = text(config.title) ?? record.name;
    const description = text(config.description);
    return {
      name: record.name,
      title,
      ...(description ? { description } : {}),
      ...(record.publishedRevision === undefined ? { unpublished: true } : {}),
      own,
      ...(refusal ? { refusal } : {}),
      ...(own && record.scope.kind === "workspace"
        ? { asset: { id: record.id, workspaceId: record.scope.workspaceId } }
        : {})
    };
  }

  /**
   * The Knowledge Bases the person may attach to the project: the instance's, its workspace's
   * and their own, each that they may search, greyed where not everyone reading it may.
   */
  private async knowledgeChoicesFor(
    user: AuthenticatedUser,
    project: Project,
    locale?: LocaleCode
  ): Promise<ProjectKnowledgeBaseChoice[] | undefined> {
    const { options } = this;
    const scope = await this.knowledgeScope(user, project);
    if (!scope) return undefined;
    const home =
      scope.workspace.kind === "personal"
        ? undefined
        : (
            await options.stores.workspaces.listWorkspacesForUser({
              clientInstanceId: options.clientInstanceId,
              userId: asUserId(scope.person)
            })
          ).find(
            (workspace) =>
              workspace.kind === "personal" && workspace.personalUserId === scope.person
          );
    const owners: AssetScope[] = [
      { kind: "instance" },
      { kind: "workspace", workspaceId: scope.workspace.id },
      ...(home ? [{ kind: "workspace" as const, workspaceId: home.id }] : [])
    ];
    const records = (
      await Promise.all(
        owners.map((owner) =>
          options.stores.configAssets.listConfigAssetPage({
            clientInstanceId: options.clientInstanceId,
            kind: KNOWLEDGE_BASE_ASSET_KIND,
            scope: owner,
            limit: KNOWLEDGE_BASES_READ,
            readable: () => true
          })
        )
      )
    ).flat();
    const choices: ProjectKnowledgeBaseChoice[] = [];
    for (const record of records) {
      const choice = await this.knowledgeChoiceOf(scope, record);
      if (choice) choices.push(choice);
    }
    choices.sort((left, right) =>
      left.title.localeCompare(right.title, locale ?? options.config.localization.defaultLocale)
    );
    return choices;
  }

  /**
   * Sets the default agent, the skills and the Knowledge Bases; what the call leaves out stays.
   * A new name must be one the caller may choose now; a name already stored may stay, as a
   * project moved or shared since keeps what no longer applies and shows it so (section 10).
   * Refused with `CONFLICT` where the project changed meanwhile.
   */
  async set(
    user: AuthenticatedUser,
    context: { correlationId: string; audit: AuditRecorder; locale?: LocaleCode },
    projectId: string,
    input: {
      defaultAgent?: string | null;
      skills?: readonly string[];
      knowledgeBases?: readonly string[];
    }
  ): Promise<ProjectSetup> {
    const { options } = this;
    const project = await requireProjectAccess(options, user, projectId);
    const [choices, knowledgeChoices] = await Promise.all([
      this.choicesFor(user, project, context.locale),
      this.knowledgeChoicesFor(user, project, context.locale)
    ]);
    const skills = input.skills === undefined ? undefined : [...new Set(input.skills)];
    if (skills && skills.length > PROJECT_SKILLS_MAX) {
      throw refused(`A project attaches at most ${String(PROJECT_SKILLS_MAX)} skills`, {
        reason: "project_skills_limit"
      });
    }
    const defaultAgent =
      input.defaultAgent === undefined ? project.defaultAgent : (input.defaultAgent ?? undefined);
    if (defaultAgent !== undefined && defaultAgent !== project.defaultAgent) {
      const choice = choices.agents.find((agent) => agent.name === defaultAgent);
      if (!choice) {
        throw refused("This agent cannot be chosen in this project", {
          reason: "project_agent_not_offered"
        });
      }
      if (choice.refusal) throw ownInSharedProject("agent");
    }
    const stored = new Set(project.skills ?? []);
    for (const name of skills ?? []) {
      if (stored.has(name)) continue;
      const choice = choices.skills.find((skill) => skill.name === name);
      if (!choice) {
        throw refused("This skill cannot be attached to this project", {
          reason: "project_skill_not_offered"
        });
      }
      if (choice.refusal) throw ownInSharedProject("skill");
    }
    const knowledgeBases =
      input.knowledgeBases === undefined ? undefined : [...new Set(input.knowledgeBases)];
    if (knowledgeBases && knowledgeBases.length > PROJECT_KNOWLEDGE_BASES_MAX) {
      throw refused(
        `A project attaches at most ${String(PROJECT_KNOWLEDGE_BASES_MAX)} Knowledge Bases`,
        { reason: "project_knowledge_bases_limit" }
      );
    }
    const storedKnowledge = new Set(project.knowledgeBases ?? []);
    for (const name of knowledgeBases ?? []) {
      if (storedKnowledge.has(name)) continue;
      // With the module off nothing new is attached; what is attached may stay or go.
      const choice = knowledgeChoices?.find((entry) => entry.name === name);
      if (!choice) {
        throw refused("This Knowledge Base cannot be attached to this project", {
          reason: "project_knowledge_base_not_offered"
        });
      }
      if (choice.refusal === "not_everyone_may_use") throw notEveryoneMayUse();
      if (choice.refusal) throw ownInSharedProject("knowledge_base");
    }
    const nextSkills = skills ?? project.skills ?? [];
    const nextKnowledge = knowledgeBases ?? project.knowledgeBases ?? [];
    const key = `${PROJECT_ASSET_KIND}:${project.name}`;
    await options.stores.transaction(async (stores) => {
      const asset = await stores.configAssets.getConfigAsset({
        clientInstanceId: options.clientInstanceId,
        kind: PROJECT_ASSET_KIND,
        name: project.name,
        lock: "share"
      });
      const current = asset ? projectDefinitionSchema.safeParse(asset.config) : undefined;
      if (!asset || asset.id !== project.id || asset.status !== "active" || !current?.success) {
        throw projectNotAvailable();
      }
      // The rest of the definition stays as it is.
      const kept: Partial<typeof current.data> = { ...current.data };
      delete kept.defaultAgent;
      delete kept.skills;
      delete kept.knowledgeBases;
      await stores.configAssets.applyConfigAssetMutations({
        clientInstanceId: options.clientInstanceId,
        baseRevisions: { [key]: asset.revision },
        baseAssetIds: { [key]: asset.id },
        actor: auditActorFromUser(user),
        mutations: [
          {
            type: "upsert",
            kind: PROJECT_ASSET_KIND,
            name: project.name,
            scope: asset.scope,
            config: {
              ...kept,
              ...(defaultAgent ? { defaultAgent } : {}),
              ...(nextSkills.length > 0 ? { skills: nextSkills } : {}),
              ...(nextKnowledge.length > 0 ? { knowledgeBases: nextKnowledge } : {})
            }
          }
        ]
      });
    });
    const after = await options.stores.projects.getProject({
      clientInstanceId: options.clientInstanceId,
      projectId: project.id
    });
    const updated = await requireProjectReadable(options, user, after);
    // Ids and counts only: an agent's, a skill's or a Knowledge Base's name can be a person's own.
    await context.audit.record({
      type: "project.setup_changed",
      status: "success",
      actor: auditActorFromUser(user),
      subject: project.id,
      correlationId: context.correlationId,
      metadata: {
        defaultAgentChanged: (project.defaultAgent ?? null) !== (updated.defaultAgent ?? null),
        skillsAdded: nextSkills.filter((name) => !stored.has(name)).length,
        skillsRemoved: [...stored].filter((name) => !nextSkills.includes(name)).length,
        knowledgeBasesAdded: nextKnowledge.filter((name) => !storedKnowledge.has(name)).length,
        knowledgeBasesRemoved: [...storedKnowledge].filter((name) => !nextKnowledge.includes(name))
          .length
      }
    });
    return this.viewOf(updated, choices, knowledgeChoices);
  }

  /**
   * The agent a new chat in the project starts with for this person, where none was named: the
   * project's default where they may choose it now, else nothing and the workspace's default
   * stands in. A project's default that is the person's own is chosen only where they alone
   * read the project; the run start marks the chat.
   */
  async defaultAgentFor(user: AuthenticatedUser, project: Project): Promise<string | undefined> {
    if (!project.defaultAgent || !this.options.modules.isEnabled("projects")) return undefined;
    const choices = await this.choicesFor(user, project);
    const choice = choices.agents.find((agent) => agent.name === project.defaultAgent);
    return choice && !choice.refusal ? choice.name : undefined;
  }

  /**
   * The skills a run in a chat's project is offered (PRJ-7): those the person may attach now,
   * and apart those of their own, which the conversation offer gives only a chat they alone
   * read. A skill attached that the person may no longer use is offered to nobody.
   */
  async skillsOf(input: {
    clientInstanceId: string;
    conversationId: string;
    user?: AuthenticatedUser;
  }): Promise<ProjectRunSkills | undefined> {
    const found = await this.runProjectOf(input);
    if (!found?.project.skills?.length) return undefined;
    const { user, project } = found;
    const choices = await this.choicesFor(user, project);
    const attached = new Set(project.skills);
    const offered = choices.skills.filter((skill) => attached.has(skill.name));
    return {
      shared: offered.filter((skill) => !skill.own).map((skill) => skill.name),
      // The person's own even where the project is shared now: the offer gives them only to a
      // chat that they alone read, which a chat of a shared project never is.
      own: offered.filter((skill) => skill.own).map((skill) => skill.name)
    };
  }

  /**
   * The Knowledge Bases a run in a chat's project may search beside its agent's (PRJ-8): those
   * attached that every reader of the chat may search now, and apart the person's own, which
   * the conversation offer gives only a chat they alone read. One that stopped applying, as
   * the project was shared since or its availability narrowed, answers in no chat of it.
   */
  async knowledgeBasesOf(input: {
    clientInstanceId: string;
    conversationId: string;
    user?: AuthenticatedUser;
  }): Promise<ProjectRunKnowledgeBases | undefined> {
    const found = await this.runProjectOf(input);
    const attached = found?.project.knowledgeBases ?? [];
    if (!found || attached.length === 0) return undefined;
    const { options } = this;
    const { user, project } = found;
    const scope = await this.knowledgeScope(user, project);
    if (!scope) return undefined;
    const records = await options.stores.configAssets.listConfigAssetsByKey({
      clientInstanceId: options.clientInstanceId,
      keys: attached.map((name) => ({ kind: KNOWLEDGE_BASE_ASSET_KIND, name }))
    });
    const shared: string[] = [];
    const own: string[] = [];
    for (const record of records) {
      const choice = await this.knowledgeChoiceOf(scope, record);
      if (!choice || choice.refusal || choice.unpublished) continue;
      (choice.own ? own : shared).push(choice.name);
    }
    return { shared, own };
  }

  /** The project of a run's chat, where the module is on and the person reads it. */
  private async runProjectOf(input: {
    conversationId: string;
    user?: AuthenticatedUser;
  }): Promise<{ user: AuthenticatedUser; project: Project } | undefined> {
    const { options } = this;
    const { user } = input;
    if (!options.modules.isEnabled("projects") || !user || isAuthenticatedServicePrincipal(user)) {
      return undefined;
    }
    let conversation = await options.stores.conversations.getConversation(
      options.clientInstanceId,
      asConversationId(input.conversationId)
    );
    // A subagent's thread works in its root's project, as its folder does.
    if (conversation?.kind === "run_thread" && conversation.parentConversationId) {
      conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversation.parentConversationId
      );
    }
    if (!conversation || conversation.status !== "active" || !conversation.projectId) {
      return undefined;
    }
    const project = await options.stores.projects.getProject({
      clientInstanceId: options.clientInstanceId,
      projectId: conversation.projectId
    });
    if (!project || project.collaborationWorkspaceId !== conversation.collaborationWorkspaceId) {
      return undefined;
    }
    try {
      await requireProjectReadable(options, user, project);
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
    return { user, project };
  }
}

function refused(message: string, details: { reason: string }): AppError {
  return new AppError("VALIDATION_FAILED", message, details, { exposeMessage: true });
}

/** The person's own agent, skill or Knowledge Base, in a project others read: sharing it opens it. */
function ownInSharedProject(kind: ProjectChoiceKind): AppError {
  return refused(
    kind === "agent"
      ? "An agent only you use cannot be the default of a project others read. Share it with the workspace first."
      : kind === KNOWLEDGE_BASE_ASSET_KIND
        ? "A Knowledge Base only you use cannot be attached to a project others read. Share it with the workspace first."
        : "A skill only you use cannot be attached to a project others read. Share it with the workspace first.",
    { reason: "own_in_shared_project" }
  );
}

/**
 * A Knowledge Base not everyone in a project's audience may search: a chat's answers from it
 * would reach readers without the right. Making it available in the workspace opens it.
 */
function notEveryoneMayUse(): AppError {
  return refused(
    "Not everyone who reads this project may use this Knowledge Base. Make it available in the workspace first.",
    { reason: "not_everyone_may_use" }
  );
}
