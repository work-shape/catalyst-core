import {
  AppError,
  asUserId,
  auditActorFromUser,
  getSubjectUserId,
  isAppError,
  PROJECT_ASSET_KIND,
  projectAudienceFor,
  projectNameFor,
  type AuditRecorder,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type Project,
  type ProjectAudience
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceAccess } from "../workspaces/workspace-access";
import { projectNotAvailable, requireProjectReadable } from "./project-access";

/** A name is made again this often when the random suffix of a new one was taken. */
const NAME_ATTEMPTS = 4;

export interface CreateProjectCommand {
  collaborationWorkspaceId: CollaborationWorkspaceId;
  title: string;
  description?: string;
  audience?: ProjectAudience;
}

/**
 * Projects (PRJ-1). Only a member of a workspace, or the superadmin as Owner of a Shared
 * Workspace, reaches its projects, and then only those in their audience: the workspace's and
 * their own private ones. The definition is an asset of the kind `project` the workspace owns,
 * written here and not through the asset operations, which do not see an audience.
 */
export class ProjectWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async list(user: AuthenticatedUser, collaborationWorkspaceId: CollaborationWorkspaceId) {
    await requireWorkspaceAccess(this.options, user, collaborationWorkspaceId);
    return {
      items: await this.options.stores.projects.listProjectsForViewer({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceIds: [collaborationWorkspaceId],
        viewerUserId: getSubjectUserId(user)
      })
    };
  }

  /**
   * The projects of every workspace the person is a member of, in their audience (PRJ-5).
   * Membership alone: the superadmin's Owner access to Shared Workspaces they are no member
   * of opens each of them on its own page and adds none here, and no grant or bundle does.
   */
  async listMine(user: AuthenticatedUser) {
    const userId = getSubjectUserId(user);
    const workspaces = await this.options.stores.workspaces.listWorkspacesForUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: asUserId(userId)
    });
    return {
      items: await this.options.stores.projects.listProjectsForViewer({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceIds: workspaces.map((workspace) => workspace.id),
        viewerUserId: userId
      })
    };
  }

  async get(user: AuthenticatedUser, name: string): Promise<Project> {
    const project = await this.options.stores.projects.getProjectByName({
      clientInstanceId: this.options.clientInstanceId,
      name
    });
    return requireProjectReadable(this.options, user, project);
  }

  async create(
    user: AuthenticatedUser,
    context: { correlationId: string; audit: AuditRecorder },
    command: CreateProjectCommand
  ): Promise<Project> {
    const { clientInstanceId } = this.options;
    try {
      await requireWorkspaceAccess(this.options, user, command.collaborationWorkspaceId);
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") {
        throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
      }
      throw error;
    }
    const workspace = await this.options.stores.workspaces.getWorkspace(
      clientInstanceId,
      command.collaborationWorkspaceId
    );
    if (!workspace) throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    const audience = projectAudienceFor(workspace, command.audience);
    const userId = getSubjectUserId(user);
    const actor = auditActorFromUser(user);
    for (let attempt = 1; ; attempt += 1) {
      const name = projectNameFor(command.title);
      const key = `${PROJECT_ASSET_KIND}:${name}`;
      try {
        const projectId = await this.options.stores.transaction(async (stores) => {
          const written = await stores.configAssets.applyConfigAssetMutations({
            clientInstanceId,
            baseRevisions: { [key]: null },
            actor,
            mutations: [
              {
                type: "upsert",
                kind: PROJECT_ASSET_KIND,
                name,
                scope: { kind: "workspace", workspaceId: workspace.id },
                config: {
                  name,
                  title: command.title,
                  ...(command.description ? { description: command.description } : {})
                }
              }
            ]
          });
          const assetId = written.assetIds[key];
          if (!assetId) throw new AppError("INTERNAL", "The project's asset was not written");
          await stores.projects.insertProjectRecord({
            clientInstanceId,
            assetId,
            createdByUserId: userId,
            audience,
            createdAt: new Date().toISOString()
          });
          return assetId;
        });
        const project = await this.options.stores.projects.getProject({
          clientInstanceId,
          projectId
        });
        if (!project) throw projectNotAvailable();
        // Ids and the audience only: the title stays out of the audit.
        await context.audit.record({
          type: "project.created",
          status: "success",
          actor,
          subject: project.id,
          correlationId: context.correlationId,
          metadata: { workspaceId: workspace.id, audience }
        });
        return project;
      } catch (error) {
        // Another project took the random name first: make another one.
        const taken =
          isAppError(error) && (error.code === "REVISION_CONFLICT" || error.code === "CONFLICT");
        if (!taken || attempt >= NAME_ATTEMPTS) throw error;
      }
    }
  }
}
