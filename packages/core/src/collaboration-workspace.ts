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
  "ruby",
  "amber",
  "emerald",
  "sapphire",
  "violet",
  "rose",
  "teal",
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
  emoji: string | null;
  accentColor: WorkspaceAccentColor | null;
  personalUserId: UserId | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
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

export interface CollaborationWorkspaceWithRole extends CollaborationWorkspace {
  role: WorkspaceMembershipRole;
}

export interface CreateWorkspaceInput {
  clientInstanceId: ClientInstanceId;
  kind: CollaborationWorkspaceKind;
  name: string;
  description?: string | null;
  visibility?: WorkspaceVisibility;
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
  emoji?: string | null;
  accentColor?: WorkspaceAccentColor | null;
}

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
  updateWorkspace(input: UpdateWorkspaceInput): Promise<CollaborationWorkspace>;
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
    return;
  }
  if (input.personalUserId) {
    throw new AppError("VALIDATION_FAILED", "A Shared Workspace cannot have a personal user");
  }
}
