import type {
  CollaborationWorkspaceWithRole,
  WorkspaceMembershipRole
} from "@vivd-catalyst/api-client";
import type { TranslationKey } from "../i18n";

export const collaborationWorkspaceRoleLabelKeys: Record<WorkspaceMembershipRole, TranslationKey> =
  {
    owner: "collaborationWorkspaceRoleOwner",
    admin: "collaborationWorkspaceRoleAdmin",
    member: "collaborationWorkspaceRoleMember"
  };

/**
 * Owners manage everyone. Admins may not grant admin or owner, which leaves no
 * role they could actually assign, so the select stays owner-only.
 */
export function canChangeCollaborationWorkspaceRole(actorRole: WorkspaceMembershipRole): boolean {
  return actorRole === "owner";
}

/** Only an owner deletes, and the Personal Workspace is never deletable. */
export function canDeleteCollaborationWorkspace(
  collaborationWorkspace: Pick<CollaborationWorkspaceWithRole, "kind" | "role">
): boolean {
  return collaborationWorkspace.kind === "shared" && collaborationWorkspace.role === "owner";
}

export function canRemoveCollaborationWorkspaceMember(
  actorRole: WorkspaceMembershipRole,
  targetRole: WorkspaceMembershipRole
): boolean {
  if (actorRole === "owner") {
    return true;
  }
  return actorRole === "admin" && targetRole === "member";
}
