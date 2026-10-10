import type { ConversationVisibility } from "./conversation";
import { AppError } from "./errors";
import type {
  ClientInstanceId,
  CollaborationWorkspaceId,
  UserId,
  WorkspaceAccessRequestId
} from "./ids";
import { createPlatformId } from "./ids";
import type { ISODateString } from "./time";

export type CollaborationWorkspaceKind = "personal" | "shared";
export type WorkspaceVisibility = "discoverable" | "private";
export type WorkspaceMembershipRole = "owner" | "admin" | "member";

export const WORKSPACE_ACCENT_COLORS = [
  "garnet",
  "ruby",
  "mahogany",
  "copper",
  "amber",
  "olive",
  "jade",
  "emerald",
  "teal",
  "turquoise",
  "azure",
  "sapphire",
  "indigo",
  "violet",
  "magenta",
  "rose",
  "stone",
  "slate"
] as const;

export type WorkspaceAccentColor = (typeof WORKSPACE_ACCENT_COLORS)[number];

export interface CollaborationWorkspace {
  id: CollaborationWorkspaceId;
  clientInstanceId: ClientInstanceId;
  kind: CollaborationWorkspaceKind;
  name: string;
  description: string | null;
  visibility: WorkspaceVisibility;
  defaultConversationVisibility: ConversationVisibility;
  emoji: string | null;
  accentColor: WorkspaceAccentColor | null;
  personalUserId: UserId | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface WorkspaceInDeletion {
  workspace: CollaborationWorkspace;
  memberships: WorkspaceMembership[];
}

export interface WorkspaceMembership {
  collaborationWorkspaceId: CollaborationWorkspaceId;
  clientInstanceId: ClientInstanceId;
  userId: UserId;
  role: WorkspaceMembershipRole;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface WorkspaceAccessRequest {
  id: WorkspaceAccessRequestId;
  collaborationWorkspaceId: CollaborationWorkspaceId;
  clientInstanceId: ClientInstanceId;
  userId: UserId;
  createdAt: ISODateString;
}

export interface WorkspaceMemberCandidate {
  userId: UserId;
  displayLabel: string;
  email: string;
  hasPendingAccessRequest: boolean;
}

export interface CollaborationWorkspaceWithRole extends CollaborationWorkspace {
  role: WorkspaceMembershipRole;
}

export interface CreateWorkspaceInput {
  clientInstanceId: ClientInstanceId;
  kind: CollaborationWorkspaceKind;
  name: string;
  description?: string | null;
  visibility?: WorkspaceVisibility;
  defaultConversationVisibility?: ConversationVisibility;
  emoji?: string | null;
  accentColor?: WorkspaceAccentColor | null;
  personalUserId?: UserId | null;
  creatorUserId: UserId;
}

export interface UpdateWorkspaceInput {
  clientInstanceId: ClientInstanceId;
  collaborationWorkspaceId: CollaborationWorkspaceId;
  name?: string;
  description?: string | null;
  visibility?: WorkspaceVisibility;
  defaultConversationVisibility?: ConversationVisibility;
  emoji?: string | null;
  accentColor?: WorkspaceAccentColor | null;
}

/**
 * A Shared Workspace whose deletion was requested is closed: no read of the store finds it or
 * a membership of it, and no write changes it. Only `getWorkspaceInDeletion` and
 * `deleteWorkspace` reach it, for the deletion itself.
 */
export interface CollaborationWorkspaceStore {
  createWorkspace(input: CreateWorkspaceInput): Promise<CollaborationWorkspace>;
  getWorkspace(
    clientInstanceId: ClientInstanceId,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<CollaborationWorkspace | undefined>;
  listWorkspacesForUser(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserId;
  }): Promise<CollaborationWorkspaceWithRole[]>;
  listDiscoverableWorkspaces(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<CollaborationWorkspace[]>;
  /** Every Shared Workspace of the instance, regardless of membership or visibility. */
  listSharedWorkspaces(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<CollaborationWorkspace[]>;
  updateWorkspace(input: UpdateWorkspaceInput): Promise<CollaborationWorkspace>;
  /**
   * Marks the workspace as being deleted, which closes it from the commit on. Resolves false
   * when the mark was already set. Nothing removes the mark; the row goes with
   * `deleteWorkspace`.
   */
  markWorkspaceDeletionRequested(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<boolean>;
  /**
   * Locks the Shared Workspaces the user owns to the end of the transaction it is called in,
   * so two owners who leave at the same moment are judged one after the other.
   */
  lockOwnedSharedWorkspaces(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserId;
  }): Promise<void>;
  /** The workspace whose deletion was requested, with its memberships, or undefined. */
  getWorkspaceInDeletion(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<WorkspaceInDeletion | undefined>;
  deleteWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<CollaborationWorkspace>;
  ensurePersonalWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserId;
  }): Promise<CollaborationWorkspace>;
  addMembership(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserId;
    role: WorkspaceMembershipRole;
  }): Promise<WorkspaceMembership>;
  updateMembershipRole(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserId;
    role: WorkspaceMembershipRole;
  }): Promise<WorkspaceMembership>;
  removeMembership(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserId;
  }): Promise<WorkspaceMembership>;
  listMemberships(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<WorkspaceMembership[]>;
  searchMemberCandidates(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    query: string;
    limit: number;
  }): Promise<WorkspaceMemberCandidate[]>;
  getMembership(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserId;
  }): Promise<WorkspaceMembership | undefined>;
  createAccessRequest(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserId;
  }): Promise<WorkspaceAccessRequest>;
  deleteAccessRequest(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserId;
  }): Promise<WorkspaceAccessRequest>;
  listAccessRequestsForWorkspace(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
  }): Promise<WorkspaceAccessRequest[]>;
  getAccessRequest(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    userId: UserId;
  }): Promise<WorkspaceAccessRequest | undefined>;
  deleteAccessRequestsForUser(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserId;
  }): Promise<number>;
  removeMembershipsForUser(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserId;
  }): Promise<number>;
  deletePersonalWorkspaceForUser(input: {
    clientInstanceId: ClientInstanceId;
    userId: UserId;
  }): Promise<CollaborationWorkspace>;
}

/**
 * The refusal of a workspace deletion while Conversations of the workspace still have data to
 * remove. Their rows lead to that data, so they stay until the retention job has removed it.
 */
export function pendingConversationCleanupError(
  workspaceKind: CollaborationWorkspace["kind"],
  pendingCleanupCount: number
): AppError {
  const subject = workspaceKind === "personal" ? "The account" : "This workspace";
  return new AppError(
    "CONFLICT",
    `${subject} cannot be deleted yet because data of its deleted conversations is still being removed. Try again later.`,
    { pendingCleanupCount }
  );
}

export function createCollaborationWorkspaceId(): CollaborationWorkspaceId {
  return createPlatformId<"CollaborationWorkspaceId">("cws");
}

export function createWorkspaceAccessRequestId(): WorkspaceAccessRequestId {
  return createPlatformId<"WorkspaceAccessRequestId">("war");
}

export function validateWorkspaceCreation(input: CreateWorkspaceInput): void {
  if (input.kind === "personal") {
    if (!input.personalUserId || input.personalUserId !== input.creatorUserId) {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace must belong to its creator");
    }
    if (input.visibility && input.visibility !== "private") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace must be private");
    }
    if (input.defaultConversationVisibility === "private") {
      throw new AppError(
        "VALIDATION_FAILED",
        "A Personal Workspace cannot default to private conversations"
      );
    }
    return;
  }
  if (input.personalUserId) {
    throw new AppError("VALIDATION_FAILED", "A Shared Workspace cannot have a personal user");
  }
}
