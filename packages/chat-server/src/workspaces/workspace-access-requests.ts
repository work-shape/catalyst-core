import { recordWorkspaceChange } from "./workspace-service-audit";
import {
  AppError,
  asUserId,
  getSubjectUserId,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type UserRecord,
  type WorkspaceMembership
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { type WorkspaceAccess } from "./workspace-access";
import { CANNOT_ADD_MEMBER_MESSAGE, requireOwnerOrAdmin } from "./workspace-service-access";
import {
  type WorkspaceAccessRequestItem,
  type WorkspaceChangeCall,
  type WorkspaceDirectoryItem,
  type WorkspaceRoleNeeded
} from "./workspace-service-types";

export async function browseDirectory(
  context: Pick<WorkspaceAccessRequestContext, "options">,
  user: AuthenticatedUser
): Promise<WorkspaceDirectoryItem[]> {
  const subjectUserId = asUserId(getSubjectUserId(user));
  const workspaces = await context.options.stores.workspaces.listDiscoverableWorkspaces({
    clientInstanceId: context.options.clientInstanceId
  });
  return Promise.all(
    workspaces.map(async (workspace) => {
      const [membership, request] = await Promise.all([
        context.options.stores.workspaces.getMembership({
          clientInstanceId: context.options.clientInstanceId,
          collaborationWorkspaceId: workspace.id,
          userId: subjectUserId
        }),
        context.options.stores.workspaces.getAccessRequest({
          clientInstanceId: context.options.clientInstanceId,
          collaborationWorkspaceId: workspace.id,
          userId: subjectUserId
        })
      ]);
      return {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        emoji: workspace.emoji,
        accentColor: workspace.accentColor,
        accessState: membership ? "member" : request ? "request_pending" : "can_request",
        createdAt: workspace.createdAt
      };
    })
  );
}

export async function requestAccess(
  context: Pick<WorkspaceAccessRequestContext, "options" | "requireDiscoverableWorkspace">,
  call: WorkspaceChangeCall,
  collaborationWorkspaceId: CollaborationWorkspaceId
) {
  const subjectUserId = asUserId(getSubjectUserId(call.user));
  await context.requireDiscoverableWorkspace(collaborationWorkspaceId);
  if (
    await context.options.stores.workspaces.getMembership({
      clientInstanceId: context.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: subjectUserId
    })
  ) {
    throw new AppError("CONFLICT", "User is already a workspace member");
  }
  if (
    await context.options.stores.workspaces.getAccessRequest({
      clientInstanceId: context.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: subjectUserId
    })
  ) {
    throw new AppError("CONFLICT", "A workspace access request is already pending");
  }
  const request = await context.options.stores.workspaces.createAccessRequest({
    clientInstanceId: context.options.clientInstanceId,
    collaborationWorkspaceId,
    userId: subjectUserId
  });
  await recordWorkspaceChange(
    call,
    collaborationWorkspaceId,
    "collaboration_workspace.access_requested",
    {
      targetUserId: subjectUserId
    }
  );
  return request;
}

export async function listAccessRequests(
  context: Pick<WorkspaceAccessRequestContext, "options" | "requireWorkspaceAccess">,
  user: AuthenticatedUser,
  collaborationWorkspaceId: CollaborationWorkspaceId
): Promise<WorkspaceAccessRequestItem[]> {
  const access = await context.requireWorkspaceAccess(user, collaborationWorkspaceId);
  requireOwnerOrAdmin(access);
  const [requests, users] = await Promise.all([
    context.options.stores.workspaces.listAccessRequestsForWorkspace({
      clientInstanceId: context.options.clientInstanceId,
      collaborationWorkspaceId
    }),
    context.options.stores.users.listUsers({ clientInstanceId: context.options.clientInstanceId })
  ]);
  const usersById = new Map(users.map((candidate) => [candidate.id, candidate]));
  return requests.map((request) => {
    const requester = usersById.get(request.userId);
    if (!requester) throw new AppError("INTERNAL", "Access requester is not available");
    return {
      userId: requester.id,
      displayLabel: requester.displayLabel,
      email: requester.email ?? null,
      createdAt: request.createdAt
    };
  });
}

export async function approveAccessRequestNow(
  context: Pick<
    WorkspaceAccessRequestContext,
    "options" | "requireRole" | "requireSharedWorkspace"
  >,
  call: WorkspaceChangeCall,
  collaborationWorkspaceId: CollaborationWorkspaceId,
  targetUserId: UserRecord["id"]
): Promise<WorkspaceMembership> {
  await context.requireRole(call, collaborationWorkspaceId, "admin");
  await context.requireSharedWorkspace(collaborationWorkspaceId);
  const request = await context.options.stores.workspaces.getAccessRequest({
    clientInstanceId: context.options.clientInstanceId,
    collaborationWorkspaceId,
    userId: targetUserId
  });
  if (!request) throw new AppError("NOT_FOUND", "Workspace Access Request is not available");
  const users = await context.options.stores.users.listUsers({
    clientInstanceId: context.options.clientInstanceId
  });
  if (!users.some((candidate) => candidate.id === targetUserId && candidate.status === "active")) {
    throw new AppError("CONFLICT", CANNOT_ADD_MEMBER_MESSAGE);
  }
  const added = await context.options.stores.workspaces.addMembership({
    clientInstanceId: context.options.clientInstanceId,
    collaborationWorkspaceId,
    userId: targetUserId,
    role: "member"
  });
  await context.options.stores.workspaces.deleteAccessRequest({
    clientInstanceId: context.options.clientInstanceId,
    collaborationWorkspaceId,
    userId: targetUserId
  });
  await recordWorkspaceChange(
    call,
    collaborationWorkspaceId,
    "collaboration_workspace.access_request_approved",
    { targetUserId }
  );
  return added;
}

export async function declineAccessRequest(
  context: Pick<WorkspaceAccessRequestContext, "options" | "requireRole">,
  call: WorkspaceChangeCall,
  collaborationWorkspaceId: CollaborationWorkspaceId,
  targetUserId: UserRecord["id"]
) {
  await context.requireRole(call, collaborationWorkspaceId, "admin");
  const request = await context.options.stores.workspaces.deleteAccessRequest({
    clientInstanceId: context.options.clientInstanceId,
    collaborationWorkspaceId,
    userId: targetUserId
  });
  await recordWorkspaceChange(
    call,
    collaborationWorkspaceId,
    "collaboration_workspace.access_request_declined",
    { targetUserId }
  );
  return request;
}

interface WorkspaceAccessRequestContext {
  options: ChatServerOptions;
  requireWorkspaceAccess(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<WorkspaceAccess>;
  requireDiscoverableWorkspace(collaborationWorkspaceId: CollaborationWorkspaceId): Promise<void>;
  requireSharedWorkspace(
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<CollaborationWorkspace>;
  requireRole(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    needed: WorkspaceRoleNeeded
  ): Promise<WorkspaceAccess>;
}
