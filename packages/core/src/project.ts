import { z } from "zod";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_TITLE_MAX_LENGTH,
  type ProjectAudience
} from "@work-shape/catalyst-asset-schemas";
import type { CollaborationWorkspace } from "./collaboration-workspace";
import type { ConversationVisibility } from "./conversation";
import type { ClientInstanceId, CollaborationWorkspaceId } from "./ids";
import type { ISODateString } from "./time";

export {
  PROJECT_ACTIONS,
  PROJECT_ASSET_KIND,
  PROJECT_AUDIENCES,
  PROJECT_DESCRIPTION_MAX_LENGTH,
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
}

/** The stored definition of a project, the config of its asset. */
export const projectDefinitionSchema = z
  .object({
    name: z.string().min(1).max(PROJECT_NAME_MAX_LENGTH),
    title: z.string().trim().min(1).max(PROJECT_TITLE_MAX_LENGTH),
    description: z.string().trim().max(PROJECT_DESCRIPTION_MAX_LENGTH).optional()
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
   * The active projects of a workspace the viewer is in the audience of: every `workspace`
   * project and their own private ones. Newest change first.
   */
  listProjectsForWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    viewerUserId: string;
  }): Promise<Project[]>;
}
