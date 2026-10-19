import {
  AppError,
  asUserId,
  createAuthorizer,
  getSubjectUserId,
  isAppError,
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

/** The bundles whose holder works in a Shared Workspace without being its member. */
const WORKSPACE_BUNDLES = ["builder", "publisher"] as const;

/**
 * Whether the user works in a workspace, and as what. A member does as `requireWorkspaceAccess`
 * says. A holder of Builder or Publisher in a Shared Workspace who is no member builds and tries
 * there in private conversations of their own (WS-BUILD-1): membership stays the only way to
 * its other conversations, its Projects and its members' files (ADR-0015), so every other check
 * asks `requireWorkspaceAccess`. Anyone else is answered as for a workspace that does not exist.
 */
export async function requireWorkspaceToWorkIn(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  user: AuthenticatedUser,
  collaborationWorkspaceId: CollaborationWorkspaceId
): Promise<{ member: boolean }> {
  try {
    await requireWorkspaceAccess(options, user, collaborationWorkspaceId);
    return { member: true };
  } catch (error) {
    if (!isAppError(error) || error.code !== "NOT_FOUND") throw error;
    if (!(await holdsWorkspaceBundle(options, user, collaborationWorkspaceId))) throw error;
    return { member: false };
  }
}

/**
 * A bundle of a Shared Workspace given as a grant row, to the user or a group of theirs, read
 * anew on every call, so a revoked one ends at once. The bundles an instance admin holds by
 * role open no workspace's conversations.
 */
export async function holdsWorkspaceBundle(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  user: AuthenticatedUser,
  workspaceId: CollaborationWorkspaceId
): Promise<boolean> {
  const workspace = await options.stores.workspaces.getWorkspace(
    options.clientInstanceId,
    workspaceId
  );
  if (workspace?.kind !== "shared") return false;
  const access = await createAuthorizer(options.stores.access).forActor(user);
  return WORKSPACE_BUNDLES.some((bundle) => {
    const decision = access.authorize(bundle, { workspaceId });
    return decision.allowed && decision.source === "grant";
  });
}

/** Membership decides, except that a superadmin is Owner of every Shared Workspace. */
export function effectiveWorkspaceRole<Role extends WorkspaceMembershipRole | null>(
  user: AuthenticatedUser,
  workspace: Pick<CollaborationWorkspace, "kind">,
  membershipRole: Role
): WorkspaceMembershipRole | Role {
  return isSuperadmin(user) && workspace.kind === "shared" ? "owner" : membershipRole;
}
