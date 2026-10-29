import {
  assetObjectPrefix,
  createPlatformId,
  isAppError,
  type CollaborationWorkspaceId,
  type UserId
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";

type CleanupOptions = Pick<ChatServerOptions, "stores" | "clientInstanceId"> &
  Partial<Pick<ChatServerOptions, "pages">>;

type ClaimedCleanupOptions = CleanupOptions & Pick<ChatServerOptions, "auditRecorder">;

/** What the cleanup after a project's claim achieved, as its audit carries it. */
export type ProjectCleanupOutcome =
  { cleanup: "complete"; objects: number } | { cleanup: "pending" };

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

/**
 * The cleanup after a project's deletion was claimed (PRJ-6): its stored bytes, then its rows.
 * The claim made it unreachable and refuses every later write, so the objects found here are
 * all it has. A failure is audited and leaves the project marked deleted with its rows, which
 * the retention job finds and finishes. Never throws.
 */
export async function attemptClaimedProjectCleanup(
  options: ClaimedCleanupOptions,
  projectId: string
): Promise<ProjectCleanupOutcome> {
  try {
    const objects = await deleteProjectObjects(options, [projectId]);
    await options.stores.projects.deleteProjects({
      clientInstanceId: options.clientInstanceId,
      projectIds: [projectId]
    });
    return { cleanup: "complete", objects };
  } catch (error) {
    // The error's code only: never a path or a title.
    await options.auditRecorder.record({
      type: "project.cleanup_failed",
      status: "failed",
      subject: projectId,
      correlationId: createPlatformId("corr"),
      metadata: {
        errorCode: isAppError(error) ? error.code : "INTERNAL",
        errorCategory: "project_cleanup"
      }
    });
    return { cleanup: "pending" };
  }
}

/**
 * Finishes projects whose deletion was claimed and whose cleanup failed or stopped, at most
 * `limit` of them. Safe to repeat. Returns how many are still pending.
 */
export async function retryDeletedProjectCleanup(
  options: ClaimedCleanupOptions,
  limit: number
): Promise<{ completedCount: number; cleanupPendingCount: number }> {
  const projectIds = await options.stores.projects.listDeletedProjectIds({
    clientInstanceId: options.clientInstanceId,
    limit
  });
  const summary = { completedCount: 0, cleanupPendingCount: 0 };
  for (const projectId of projectIds) {
    const outcome = await attemptClaimedProjectCleanup(options, projectId);
    if (outcome.cleanup === "pending") {
      summary.cleanupPendingCount += 1;
      continue;
    }
    await options.auditRecorder.record({
      type: "project.cleanup_completed",
      status: "success",
      subject: projectId,
      correlationId: createPlatformId("corr"),
      metadata: { objects: outcome.objects }
    });
    summary.completedCount += 1;
  }
  return summary;
}
