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
  PROJECT_DELETION_CONVERSATIONS,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_CHOICE_REFUSALS,
  PROJECT_KNOWLEDGE_BASES_MAX,
  PROJECT_SKILLS_MAX,
  PROJECT_TITLE_MAX_LENGTH,
  type ProjectAudience,
  type ProjectDeletionConversations
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

/**
 * What a change to a whole project reaches (PRJ-6): the dialogs of an audience change, a move
 * and a deletion count it before the person confirms.
 */
export interface ProjectImpact {
  /** The active chats in the project, drafts included. */
  conversations: number;
  /** Of those, the chats someone other than the project's creator started. */
  conversationsOfOthers: number;
  /**
   * Of those, the chats that must stay private: one holding personal data, one that reads a
   * Data Store a person added, or one about an asset. They keep a project from being shared.
   */
  conversationsKeptPrivate: number;
  /** The files of the project as they are now, deleted ones not counted. */
  files: number;
  /** Of those, the files whose current version someone other than the creator made. */
  filesOfOthers: number;
  /**
   * The files with a kept version that a chat which must stay private wrote, or a chat that is
   * gone. They keep a project from being shared until they or their versions are removed.
   */
  filesKeptPrivate: number;
}

/** What an audience change did to the project's chats. */
export interface ProjectAudienceChange {
  project: Project;
  /** Chats every member of the workspace reads from now on. */
  conversationsShared: number;
  /** Chats of other members that left the project and stay in the workspace, shared. */
  conversationsLeft: number;
  /** The creator's own chats that only the creator reads from now on. */
  conversationsMadePrivate: number;
}

/** What a move did. */
export interface ProjectMove {
  project: Project;
  /** The chats that moved with the project. */
  conversationsMoved: number;
  /** The grants on the project that ended with the move. */
  grantsDropped: number;
}

/** The criterion of the retention job's deletion of an idle project, re-read under the lock. */
export interface ProjectIdleCriterion {
  /** The last activity must be at or before this. */
  idleBefore: ISODateString;
  /** The notice must have gone out at or before this, with no activity since. */
  noticedBefore: ISODateString;
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
  /** What a change to the whole project reaches; zeros for a project that is gone. */
  getProjectImpact(input: {
    clientInstanceId: ClientInstanceId;
    projectId: string;
  }): Promise<ProjectImpact>;
  /** The active chats in a project, drafts included. */
  listProjectConversationIds(input: {
    clientInstanceId: ClientInstanceId;
    projectId: string;
  }): Promise<string[]>;
  /**
   * Changes who reads a project, under its row lock (PRJ-6). To `workspace`: every chat in it
   * is shared, refused whole (`CONFLICT`, `project_conversations_stay_private`) while one must
   * stay private. To `private`: other members' chats leave the project and stay shared in the
   * workspace; the creator's own become private. `CONFLICT` where the audience is no longer
   * `expectedAudience`.
   */
  setProjectAudience(input: {
    clientInstanceId: ClientInstanceId;
    projectId: string;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    expectedAudience: ProjectAudience;
    audience: ProjectAudience;
    changedAt: ISODateString;
  }): Promise<ProjectAudienceChange>;
  /**
   * Moves a project to another workspace in one transaction: the asset's owner, its audience,
   * and every chat in it with its run threads, which take the project's audience (`workspace`
   * in a Personal Workspace). Grants on the project end. The files stay under the project's
   * own prefix. Refused (`CONFLICT`) into a Personal Workspace while it holds chats of
   * someone else, and into a shared audience while a chat must stay private.
   */
  moveProject(input: {
    clientInstanceId: ClientInstanceId;
    projectId: string;
    fromCollaborationWorkspaceId: CollaborationWorkspaceId;
    toCollaborationWorkspaceId: CollaborationWorkspaceId;
    audience: ProjectAudience;
    movedAt: ISODateString;
  }): Promise<ProjectMove>;
  /**
   * The claim of a deletion (PRJ-6): under the project's row lock, an active project is marked
   * deleted and every chat that still names it leaves it, keeping its visibility. From here
   * no file is written into it and nobody reads it. With `idle`, the retention job's criterion
   * is evaluated again under the lock first. The stored bytes and the rows are the cleanup's,
   * after the claim.
   */
  claimProjectDeletion(input: {
    clientInstanceId: ClientInstanceId;
    projectId: string;
    collaborationWorkspaceId?: CollaborationWorkspaceId;
    idle?: ProjectIdleCriterion;
    /** The person chose to delete the chats in the project with it: they are claimed too. */
    deleteConversations?: boolean;
    deletedAt: ISODateString;
  }): Promise<
    | {
        status: "claimed";
        /** The active chats that were in the project and now stand in its workspace alone. */
        conversationIds: string[];
        /** The chats claimed for deletion with the project; their cleanup follows. */
        deletedConversationIds: string[];
      }
    | { status: "not_claimed" }
  >;
  /** Projects claimed for deletion whose cleanup has not finished: the retry's work. */
  listDeletedProjectIds(input: {
    clientInstanceId: ClientInstanceId;
    limit: number;
  }): Promise<string[]>;
  /**
   * Forgets the idle notice of every project with activity after it, so that the next idle
   * period is noticed again. Returns how many.
   */
  clearIdleNoticesAfterActivity(input: { clientInstanceId: ClientInstanceId }): Promise<number>;
  /** Active projects without a notice whose last activity is at or before `idleBefore`. */
  listProjectsToNotice(input: {
    clientInstanceId: ClientInstanceId;
    idleBefore: ISODateString;
    limit: number;
  }): Promise<Project[]>;
  /**
   * Records the idle notice under the project's row lock where it is still idle and not yet
   * noticed; false where not. Call it in the transaction that files the notice.
   */
  markIdleNotice(input: {
    clientInstanceId: ClientInstanceId;
    projectId: string;
    idleBefore: ISODateString;
    noticedAt: ISODateString;
  }): Promise<boolean>;
  /** Active projects the idle criterion deletes now. */
  listIdleProjectsToDelete(
    input: ProjectIdleCriterion & { clientInstanceId: ClientInstanceId; limit: number }
  ): Promise<string[]>;
  /**
   * Deletes projects with their definition, audience and file rows. Every conversation that
   * names one, a deleted one too, leaves it first. The stored objects are the caller's.
   */
  deleteProjects(input: {
    clientInstanceId: ClientInstanceId;
    projectIds: readonly string[];
  }): Promise<{ deleted: number; conversationsLeft: number }>;
}
