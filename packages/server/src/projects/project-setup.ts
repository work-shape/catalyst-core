import { resolveLocalizedString } from "@work-shape/catalyst-config-schema";
import {
  AppError,
  asCollaborationWorkspaceId,
  asConversationId,
  auditActorFromUser,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  PROJECT_ASSET_KIND,
  PROJECT_SKILLS_MAX,
  projectDefinitionSchema,
  projectReadOnlyBy,
  type AgentConfig,
  type AuditRecorder,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type LocaleCode,
  type Project,
  type ProjectChoiceKind,
  type ProjectRunSkills,
  type ProjectSkillsPort
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
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

export type ProjectSetupOptions = Pick<
  ChatServerOptions,
  "stores" | "clientInstanceId" | "config" | "modules"
> &
  Partial<Pick<ChatServerOptions, "authorizer">> & {
    configAssets: Pick<ChatServerOptions["configAssets"], "source" | "store">;
  };

/** Why a choice is greyed: the person's own, in a project others read. */
type ProjectChoiceRefusal = "own_in_shared_project";

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

export interface ProjectSetup {
  defaultAgent?: string;
  skills: string[];
  workspaceDefaultAgent?: string;
  agents: ProjectAgentChoice[];
  skillChoices: ProjectSkillChoice[];
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
    return this.viewOf(project, await this.choicesFor(user, project, locale));
  }

  private viewOf(project: Project, choices: ProjectChoices): ProjectSetup {
    return {
      ...(project.defaultAgent ? { defaultAgent: project.defaultAgent } : {}),
      skills: project.skills ?? [],
      ...(choices.workspaceDefaultAgent
        ? { workspaceDefaultAgent: choices.workspaceDefaultAgent }
        : {}),
      agents: choices.agents,
      skillChoices: choices.skills
    };
  }

  /**
   * Sets the default agent and the skills. A new name must be one the caller may choose now; a
   * name already stored may stay, as a project moved or shared since keeps what no longer
   * applies and shows it so (section 10). Refused with `CONFLICT` where the project changed
   * meanwhile.
   */
  async set(
    user: AuthenticatedUser,
    context: { correlationId: string; audit: AuditRecorder; locale?: LocaleCode },
    projectId: string,
    input: { defaultAgent: string | null; skills: readonly string[] }
  ): Promise<ProjectSetup> {
    const { options } = this;
    const project = await requireProjectAccess(options, user, projectId);
    const choices = await this.choicesFor(user, project, context.locale);
    const skills = [...new Set(input.skills)];
    if (skills.length > PROJECT_SKILLS_MAX) {
      throw refused(`A project attaches at most ${String(PROJECT_SKILLS_MAX)} skills`, {
        reason: "project_skills_limit"
      });
    }
    const defaultAgent = input.defaultAgent ?? undefined;
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
    for (const name of skills) {
      if (stored.has(name)) continue;
      const choice = choices.skills.find((skill) => skill.name === name);
      if (!choice) {
        throw refused("This skill cannot be attached to this project", {
          reason: "project_skill_not_offered"
        });
      }
      if (choice.refusal) throw ownInSharedProject("skill");
    }
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
              ...(skills.length > 0 ? { skills } : {})
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
    // Ids and counts only: an agent's or a skill's name can be a person's own.
    await context.audit.record({
      type: "project.setup_changed",
      status: "success",
      actor: auditActorFromUser(user),
      subject: project.id,
      correlationId: context.correlationId,
      metadata: {
        defaultAgentChanged: (project.defaultAgent ?? null) !== (updated.defaultAgent ?? null),
        skillsAdded: skills.filter((name) => !stored.has(name)).length,
        skillsRemoved: [...stored].filter((name) => !skills.includes(name)).length
      }
    });
    return this.viewOf(updated, choices);
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
    if (
      !project?.skills?.length ||
      project.collaborationWorkspaceId !== conversation.collaborationWorkspaceId
    ) {
      return undefined;
    }
    try {
      await requireProjectReadable(options, user, project);
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
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
}

function refused(message: string, details: { reason: string }): AppError {
  return new AppError("VALIDATION_FAILED", message, details, { exposeMessage: true });
}

/** The person's own agent or skill, in a project others read: sharing it opens it. */
function ownInSharedProject(kind: ProjectChoiceKind): AppError {
  return refused(
    kind === "agent"
      ? "An agent only you use cannot be the default of a project others read. Share it with the workspace first."
      : "A skill only you use cannot be attached to a project others read. Share it with the workspace first.",
    { reason: "own_in_shared_project" }
  );
}
