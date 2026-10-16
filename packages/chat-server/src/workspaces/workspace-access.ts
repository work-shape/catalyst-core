import {
  AppError,
  asUserId,
  getSubjectUserId,
  isSuperadmin,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type UserRecord,
  type WorkspaceMembershipRole
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";

/**
 * What a user may do in one Collaboration Workspace. A superadmin acts as Owner of every Shared
 * Workspace, so `role` can exceed the user's own Workspace Membership or exist without one.
 */
export interface WorkspaceAccess {
  userId: UserRecord["id"];
  role: WorkspaceMembershipRole;
  /** The user's own Workspace Membership role; null when only the superadmin role gives access. */
  membershipRole: WorkspaceMembershipRole | null;
}

/**
 * The single access check for a Collaboration Workspace. Nobody but its user reaches a
 * Personal Workspace, and private Conversations stay with their author (ADR-0015). A workspace
 * the user cannot reach is answered as one that does not exist.
 */
export async function requireWorkspaceAccess(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  user: AuthenticatedUser,
  collaborationWorkspaceId: CollaborationWorkspaceId
): Promise<WorkspaceAccess> {
  const userId = asUserId(getSubjectUserId(user));
  const membership = await options.stores.workspaces.getMembership({
    clientInstanceId: options.clientInstanceId,
    collaborationWorkspaceId,
    userId
  });
  const membershipRole = membership?.role ?? null;
  // Only a superadmin's access depends on the workspace itself, so only they load it here.
  const workspace = isSuperadmin(user)
    ? await options.stores.workspaces.getWorkspace(
        options.clientInstanceId,
        collaborationWorkspaceId
      )
    : undefined;
  const role = workspace ? effectiveWorkspaceRole(user, workspace, membershipRole) : membershipRole;
  if (!role) {
    throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
  }
  return { userId, role, membershipRole };
}

/** Membership decides, except that a superadmin is Owner of every Shared Workspace. */
export function effectiveWorkspaceRole<Role extends WorkspaceMembershipRole | null>(
  user: AuthenticatedUser,
  workspace: Pick<CollaborationWorkspace, "kind">,
  membershipRole: Role
): WorkspaceMembershipRole | Role {
  return isSuperadmin(user) && workspace.kind === "shared" ? "owner" : membershipRole;
}
