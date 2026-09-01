import { apiOperations } from "@vivd-catalyst/api-contract";
import {
  AppError,
  asCollaborationWorkspaceId,
  asUserId,
  requireAuthScope
} from "@vivd-catalyst/core";
import type { FastifyInstance } from "fastify";
import { CollaborationWorkspaceWorkflow } from "../collaboration-workspace-workflow";
import { authenticateRequest, parseBody } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerCollaborationWorkspaceRoutes(
  app: FastifyInstance,
  options: ChatServerOptions
): void {
  const workspaces = new CollaborationWorkspaceWorkflow(options);

  app.get(apiOperations.listCollaborationWorkspaces.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:read");
    return workspaces.listWorkspaces(user);
  });

  app.post(apiOperations.createCollaborationWorkspace.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    const body = parseBody(apiOperations.createCollaborationWorkspace.requestSchema, request.body);
    return workspaces.createSharedWorkspace(user, context, body);
  });

  app.get(apiOperations.listCollaborationWorkspaceDirectory.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:read");
    return workspaces.browseDirectory(user);
  });

  app.get(apiOperations.getCollaborationWorkspace.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:read");
    return workspaces.getWorkspace(user, getCollaborationWorkspaceId(request.params));
  });

  app.patch(apiOperations.updateCollaborationWorkspace.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    const body = parseBody(apiOperations.updateCollaborationWorkspace.requestSchema, request.body);
    return workspaces.updateSettings(
      user,
      context,
      getCollaborationWorkspaceId(request.params),
      body
    );
  });

  app.get(apiOperations.getCollaborationWorkspaceDeletionImpact.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    return workspaces.getDeletionImpact(user, getCollaborationWorkspaceId(request.params));
  });

  app.delete(apiOperations.deleteCollaborationWorkspace.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    const body = parseBody(apiOperations.deleteCollaborationWorkspace.requestSchema, request.body);
    return workspaces.deleteSharedWorkspace(
      user,
      context,
      getCollaborationWorkspaceId(request.params),
      body.confirmName
    );
  });

  app.get(apiOperations.listCollaborationWorkspaceMembers.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:read");
    return workspaces.listMembers(user, getCollaborationWorkspaceId(request.params));
  });

  app.get(apiOperations.listCollaborationWorkspaceMemberCandidates.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    const query = (request.query as { q?: unknown }).q;
    return workspaces.searchMemberCandidates(
      user,
      getCollaborationWorkspaceId(request.params),
      typeof query === "string" ? query : ""
    );
  });

  app.post(apiOperations.addCollaborationWorkspaceMember.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    const body = parseBody(
      apiOperations.addCollaborationWorkspaceMember.requestSchema,
      request.body
    );
    return workspaces.addMemberByEmail(
      user,
      context,
      getCollaborationWorkspaceId(request.params),
      body.email
    );
  });

  app.delete(apiOperations.leaveCollaborationWorkspace.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    return workspaces.leaveWorkspace(user, context, getCollaborationWorkspaceId(request.params));
  });

  app.patch(apiOperations.updateCollaborationWorkspaceMemberRole.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    const body = parseBody(
      apiOperations.updateCollaborationWorkspaceMemberRole.requestSchema,
      request.body
    );
    const params = getWorkspaceUserParams(request.params);
    return workspaces.changeMemberRole(
      user,
      context,
      params.collaborationWorkspaceId,
      params.userId,
      body.role
    );
  });

  app.delete(apiOperations.removeCollaborationWorkspaceMember.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    const params = getWorkspaceUserParams(request.params);
    return workspaces.removeMember(user, context, params.collaborationWorkspaceId, params.userId);
  });

  app.post(apiOperations.requestCollaborationWorkspaceAccess.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    return workspaces.requestAccess(user, context, getCollaborationWorkspaceId(request.params));
  });

  app.get(apiOperations.listCollaborationWorkspaceAccessRequests.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:read");
    return workspaces.listAccessRequests(user, getCollaborationWorkspaceId(request.params));
  });

  app.post(apiOperations.approveCollaborationWorkspaceAccessRequest.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    const params = getWorkspaceUserParams(request.params);
    return workspaces.approveAccessRequest(
      user,
      context,
      params.collaborationWorkspaceId,
      params.userId
    );
  });

  app.delete(apiOperations.declineCollaborationWorkspaceAccessRequest.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "collaboration_workspace:manage");
    const params = getWorkspaceUserParams(request.params);
    return workspaces.declineAccessRequest(
      user,
      context,
      params.collaborationWorkspaceId,
      params.userId
    );
  });
}

function getCollaborationWorkspaceId(params: unknown) {
  const collaborationWorkspaceId = (params as { collaborationWorkspaceId?: string })
    .collaborationWorkspaceId;
  if (!collaborationWorkspaceId) {
    throw new AppError("BAD_REQUEST", "Missing Collaboration Workspace id");
  }
  return asCollaborationWorkspaceId(collaborationWorkspaceId);
}

function getWorkspaceUserParams(params: unknown) {
  const typed = params as { collaborationWorkspaceId?: string; userId?: string };
  if (!typed.userId) throw new AppError("BAD_REQUEST", "Missing user id");
  return {
    collaborationWorkspaceId: getCollaborationWorkspaceId(params),
    userId: asUserId(typed.userId)
  };
}
