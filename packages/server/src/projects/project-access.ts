import {
  AppError,
  getSubjectUserId,
  inProjectAudience,
  isAppError,
  type AuthenticatedUser,
  type Project
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceAccess } from "../workspaces/workspace-access";

type ProjectAccessOptions = Pick<ChatServerOptions, "stores" | "clientInstanceId">;

export function projectNotAvailable(): AppError {
  return new AppError("NOT_FOUND", "Project is not available");
}

/** `requireProjectReadable` of the project with this asset id. */
export async function requireProjectAccess(
  options: ProjectAccessOptions,
  user: AuthenticatedUser,
  projectId: string
): Promise<Project> {
  const project = await options.stores.projects.getProject({
    clientInstanceId: options.clientInstanceId,
    projectId
  });
  return requireProjectReadable(options, user, project);
}

/**
 * The single read check of a project (PRJ-1): the user reaches its workspace as a member, or
 * as the superadmin who is Owner of a Shared Workspace, and is in its audience. No grant and
 * no bundle opens a project, so the evaluator is not asked. Every refusal reads as a project
 * that does not exist.
 */
export async function requireProjectReadable(
  options: ProjectAccessOptions,
  user: AuthenticatedUser,
  project: Project | undefined
): Promise<Project> {
  if (!project) throw projectNotAvailable();
  try {
    await requireWorkspaceAccess(options, user, project.collaborationWorkspaceId);
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") throw projectNotAvailable();
    throw error;
  }
  if (!inProjectAudience(project, getSubjectUserId(user))) throw projectNotAvailable();
  return project;
}
