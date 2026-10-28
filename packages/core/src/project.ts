import { z } from "zod";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_KNOWLEDGE_BASES_MAX,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_SKILLS_MAX,
  PROJECT_TITLE_MAX_LENGTH,
  type ConfigAssetKind as ConfigAssetKindName,
  type ProjectAudience
} from "@work-shape/catalyst-asset-schemas";
import type { CollaborationWorkspace } from "./collaboration-workspace";
import type { ConversationVisibility } from "./conversation";
import type { ClientInstanceId, CollaborationWorkspaceId } from "./ids";
import type { AuthenticatedUser } from "./identity";
import type { ISODateString } from "./time";

export {
  PROJECT_ACTIONS,
  PROJECT_ASSET_KIND,
  PROJECT_AUDIENCES,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_CHOICE_REFUSALS,
  PROJECT_KNOWLEDGE_BASES_MAX,
  PROJECT_SKILLS_MAX,
  PROJECT_TITLE_MAX_LENGTH,
  type ProjectAudience
} from "@work-shape/catalyst-asset-schemas";

/**
 * A named folder of chat work inside exactly one Collaboration Workspace (PRJ-1). Its
 * definition is an asset of the kind `project` the workspace owns; its audience is beside the
 * definition, so restoring a revision never shares or hides it. A conversation in a project is
 * read by exactly the project's audience.
 */
export interface Project {
  /** The id of the project's asset. */
  id: string;
  clientInstanceId: ClientInstanceId;
  /** Made by the server from the title and a random suffix; never changes. */
  name: string;
  collaborationWorkspaceId: CollaborationWorkspaceId;
  title: string;
  description?: string;
  audience: ProjectAudience;
  createdByUserId: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  /**
   * The agent a new chat in the project starts with (PRJ-7). Not a lock; where it is not
   * offered to the person now, the workspace's default stands in.
   */
  defaultAgent?: string;
  /** The skills every run in the project is offered beside its agent's own (PRJ-7). */
  skills?: string[];
  /**
   * The Knowledge Bases every run in the project may search beside its agent's own (PRJ-8).
   * Attaching grants nothing: each search asks the person's `knowledge_base.use`.
   */
  knowledgeBases?: string[];
}

/** The longest name of an agent or a skill a project names. */
const PROJECT_ASSET_NAME_MAX_LENGTH = 128;

/** The stored definition of a project, the config of its asset. */
export const projectDefinitionSchema = z
  .object({
    name: z.string().min(1).max(PROJECT_NAME_MAX_LENGTH),
    title: z.string().trim().min(1).max(PROJECT_TITLE_MAX_LENGTH),
    description: z.string().trim().max(PROJECT_DESCRIPTION_MAX_LENGTH).optional(),
    defaultAgent: z.string().min(1).max(PROJECT_ASSET_NAME_MAX_LENGTH).optional(),
    skills: z
      .array(z.string().min(1).max(PROJECT_ASSET_NAME_MAX_LENGTH))
      .max(PROJECT_SKILLS_MAX)
      .optional(),
    knowledgeBases: z
      .array(z.string().min(1).max(PROJECT_ASSET_NAME_MAX_LENGTH))
      .max(PROJECT_KNOWLEDGE_BASES_MAX)
      .optional()
  })
  .strict();

export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;

/**
 * The name of a new project: the title in lowercase words and a random suffix, always. Two
 * workspaces can both have a project of one title, and a refused name never tells a person
 * that another workspace has one.
 */
export function projectNameFor(title: string, random: () => number = Math.random): string {
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/gu, "ss")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let suffix = "";
  for (let index = 0; index < 4; index += 1) {
    suffix += alphabet[Math.floor(random() * alphabet.length)] ?? "x";
  }
  const stem = words.slice(0, PROJECT_NAME_MAX_LENGTH - suffix.length - 1).replace(/-+$/u, "");
  return stem ? `${stem}-${suffix}` : `project-${suffix}`;
}

/**
 * The audience of a new project where its creator chose none: the workspace's default for
 * conversations. A Personal Workspace has one person, so its projects are always `workspace`.
 */
export function projectAudienceFor(
  workspace: Pick<CollaborationWorkspace, "kind" | "defaultConversationVisibility">,
  chosen?: ProjectAudience
): ProjectAudience {
  if (workspace.kind === "personal") return "workspace";
  return chosen ?? workspace.defaultConversationVisibility;
}

/** The visibility a conversation takes when it enters a project of this audience. */
export function conversationVisibilityInProject(audience: ProjectAudience): ConversationVisibility {
  return audience;
}

/** Whether a person with access to the project's workspace is in its audience. */
export function inProjectAudience(
  project: Pick<Project, "audience" | "createdByUserId">,
  userId: string
): boolean {
  return project.audience === "workspace" || project.createdByUserId === userId;
}

/**
 * Whether no one but `person` reads the project and every chat in it (PRJ-7): their own
 * Personal Workspace's, or a private one they made in a team. There, and only there, what is
 * theirs alone, an agent or a skill of their Personal Workspace, may be its default or
 * attached; a chat that uses it is marked personal, as in their own chats outside a project.
 */
export function projectReadOnlyBy(
  project: Pick<Project, "audience" | "createdByUserId">,
  workspace: { kind: "personal" | "shared"; personalUserId?: string | null } | undefined,
  person: string
): boolean {
  if (workspace === undefined) return false;
  return workspace.kind === "personal"
    ? workspace.personalUserId === person
    : project.audience === "private" && project.createdByUserId === person;
}

/**
 * The skills a chat's project attaches, as a run of one person may read them (PRJ-7): those the
 * project's audience may use, and the person's own, which only a chat they alone read is offered.
 */
export interface ProjectRunSkills {
  shared: string[];
  own: string[];
}

/**
 * The Knowledge Bases a chat's project attaches, as a run of one person may search them (PRJ-8):
 * those every reader of the chat may use, and the person's own, which only a chat they alone
 * read is offered. One a reader of the chat may not use is in neither.
 */
export type ProjectRunKnowledgeBases = ProjectRunSkills;

/**
 * What a project names besides its files: its default agent and its skills (PRJ-7), and its
 * Knowledge Bases (PRJ-8).
 */
export type ProjectChoiceKind = ConfigAssetKindName | "knowledge_base";

/** Where a run reads the skills and Knowledge Bases of its chat's project. */
export interface ProjectSkillsPort {
  /** Nothing where the chat is in no project, the module is off or its person is not in its audience. */
  skillsOf(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: string;
    user?: AuthenticatedUser;
  }): Promise<ProjectRunSkills | undefined>;
  /** As `skillsOf`, and nothing where the module `knowledge` is off (PRJ-8). */
  knowledgeBasesOf?(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: string;
    user?: AuthenticatedUser;
  }): Promise<ProjectRunKnowledgeBases | undefined>;
}

/** A project as a list shows it: with how many chats it holds and when it was last used. */
export interface ProjectListEntry extends Project {
  /** The sent chats in the project; everyone in its audience reads all of them. */
  conversationCount: number;
  /** The latest change to the project or to a chat in it. */
  lastActivityAt: ISODateString;
}

export interface CreateProjectRecordInput {
  clientInstanceId: ClientInstanceId;
  assetId: string;
  createdByUserId: string;
  audience: ProjectAudience;
  createdAt: ISODateString;
}

export interface ProjectStore {
  /** The audience of a project asset written in the same transaction. */
  insertProjectRecord(input: CreateProjectRecordInput): Promise<void>;
  /** An active project by its asset id, with its audience. */
  getProject(input: {
    clientInstanceId: ClientInstanceId;
    projectId: string;
  }): Promise<Project | undefined>;
  getProjectByName(input: {
    clientInstanceId: ClientInstanceId;
    name: string;
  }): Promise<Project | undefined>;
  /**
   * The active projects of these workspaces the viewer is in the audience of: every
   * `workspace` project and their own private ones, each with its chats counted. The caller
   * names only workspaces the viewer reaches. Latest activity first (PRJ-5).
   */
  listProjectsForViewer(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceIds: readonly CollaborationWorkspaceId[];
    viewerUserId: string;
  }): Promise<ProjectListEntry[]>;
  /** Every project of a workspace whatever its audience or status: what its deletion removes. */
  listProjectIdsOfWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<string[]>;
  /** The private projects a person made, in any workspace: what their deletion removes. */
  listPrivateProjectIdsCreatedBy(input: {
    clientInstanceId: ClientInstanceId;
    userId: string;
  }): Promise<string[]>;
  /**
   * Deletes projects with their definition, audience and file rows. Every conversation that
   * names one, a deleted one too, leaves it first. The stored objects are the caller's.
   */
  deleteProjects(input: {
    clientInstanceId: ClientInstanceId;
    projectIds: readonly string[];
  }): Promise<{ deleted: number; conversationsLeft: number }>;
}
