import {
  assetObjectPrefix,
  type CollaborationWorkspaceId,
  type UserId
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";

type CleanupOptions = Pick<ChatServerOptions, "stores" | "clientInstanceId"> &
  Partial<Pick<ChatServerOptions, "pages">>;

/**
 * Removes the stored bytes of projects, the files of each under its asset's prefix. The rows go
 * with the project's asset. Called before the rows are deleted, so a pass that fails here
 * still finds the projects and repeats it.
 */
async function deleteProjectObjects(
  options: CleanupOptions,
  projectIds: readonly string[]
): Promise<number> {
  const objects = options.pages?.objects;
  if (!objects) return 0;
  let deleted = 0;
  for (const projectId of projectIds) {
    deleted += (await objects.deletePrefix(assetObjectPrefix(projectId))).deleted;
  }
  return deleted;
}

/** The objects of a workspace's projects, before the store deletes the workspace's assets. */
export async function deleteWorkspaceProjectObjects(
  options: CleanupOptions,
  collaborationWorkspaceId: CollaborationWorkspaceId
): Promise<number> {
  const projectIds = await options.stores.projects.listProjectIdsOfWorkspace({
    clientInstanceId: options.clientInstanceId,
    collaborationWorkspaceId
  });
  return deleteProjectObjects(options, projectIds);
}

/**
 * The private projects a deleted user created in Shared Workspaces go with them, with their
 * files: nobody else can read them. Conversations that still point at one are taken out of it
 * first. The user's name on versions of files that stay, in projects of the workspace, is
 * forgotten. Returns how many projects were deleted.
 */
export async function deletePrivateProjectsOfUser(
  options: CleanupOptions,
  userId: UserId
): Promise<number> {
  const projectIds = await options.stores.projects.listPrivateProjectIdsCreatedBy({
    clientInstanceId: options.clientInstanceId,
    userId
  });
  await deleteProjectObjects(options, projectIds);
  const { deleted } =
    projectIds.length > 0
      ? await options.stores.projects.deleteProjects({
          clientInstanceId: options.clientInstanceId,
          projectIds
        })
      : { deleted: 0 };
  await options.stores.projectFiles.forgetProjectFileAuthor({
    clientInstanceId: options.clientInstanceId,
    userId
  });
  return deleted;
}
