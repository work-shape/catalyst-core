import {
  type ActorAccess,
  type AuditRecorder,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type CollaborationWorkspaceWithRole,
  type ConversationVisibility,
  type ISODateString,
  type UserRecord,
  type WorkspaceAccentColor,
  type WorkspaceMembershipRole,
  type WorkspaceVisibility
} from "@work-shape/catalyst-core";

/** The least role a workspace operation asks of its caller. `member` is any role. */
export type WorkspaceRoleNeeded = "member" | "admin" | "owner";

/** What a changing workspace operation takes from its Operation Run. */
export interface WorkspaceChangeCall {
  /** The operation, which a refusal names: no right a caller can be granted opens it. */
  operationId: string;
  user: AuthenticatedUser;
  /** The caller's rights as the call was admitted; a change of members reads them anew. */
  access: ActorAccess;
  /** Writes audit rows that name the run. */
  audit: AuditRecorder;
  correlationId: string;
}

export interface WorkspaceListItem extends CollaborationWorkspaceWithRole {
  membershipRole: WorkspaceMembershipRole | null;
  pendingAccessRequestCount: number;
}

export interface WorkspaceDirectoryItem {
  id: CollaborationWorkspaceId;
  name: string;
  description: string | null;
  emoji: string | null;
  accentColor: WorkspaceAccentColor | null;
  accessState: "member" | "request_pending" | "can_request";
  createdAt: ISODateString;
}

export interface WorkspaceMemberItem {
  userId: UserRecord["id"];
  displayLabel: string;
  email: string | null;
  role: WorkspaceMembershipRole;
}

export interface WorkspaceAccessRequestItem {
  userId: UserRecord["id"];
  displayLabel: string;
  email: string | null;
  createdAt: string;
}

export interface WorkspaceDeletionImpact {
  conversationCount: number;
  memberCount: number;
  pendingAccessRequestCount: number;
}

export interface CreateSharedWorkspaceCommand {
  name: string;
  description?: string | null;
  visibility?: WorkspaceVisibility;
  defaultConversationVisibility?: ConversationVisibility;
  emoji?: string | null;
  accentColor?: WorkspaceAccentColor | null;
}

export interface UpdateWorkspaceSettingsCommand {
  name?: string;
  description?: string | null;
  visibility?: WorkspaceVisibility;
  defaultConversationVisibility?: ConversationVisibility;
  emoji?: string | null;
  accentColor?: WorkspaceAccentColor | null;
}
