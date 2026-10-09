import { apiOperations } from "@vivd-catalyst/api-contract";
import { createSafeConfigView } from "@vivd-catalyst/config-schema";
import { asCollaborationWorkspaceId, asUserId } from "@vivd-catalyst/core";
import { CollaborationWorkspaceWorkflow } from "../collaboration-workspace-workflow";
import type { Route } from "../http/route";
import { requirePathParam, resolveRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerCollaborationWorkspaceRoutes(
  route: Route,
  options: ChatServerOptions
): void {
  const workspaces = new CollaborationWorkspaceWorkflow(options);

  route(apiOperations.listCollaborationWorkspaces, async ({ user }) => {
    return workspaces.listWorkspaces(user);
  });

  route(apiOperations.createCollaborationWorkspace, async ({ user, context, body }) => {
    return workspaces.createSharedWorkspace(user, context, body);
  });

  route(apiOperations.listCollaborationWorkspaceDirectory, async ({ user }) => {
    return workspaces.browseDirectory(user);
  });

  route(apiOperations.getCollaborationWorkspace, async ({ user, params }) => {
    return workspaces.getWorkspace(user, collaborationWorkspaceId(params));
  });

  route(apiOperations.listCollaborationWorkspaceAgents, async ({ user, params, request }) => {
    const assets = await workspaces.getAssetSnapshot(user, collaborationWorkspaceId(params));
    const { defaultAgentName, agents } = createSafeConfigView(options.config, assets, {
      requestedLocale: resolveRequestLocale(options, request)
    });
    return { defaultAgentName, agents };
  });

  route(apiOperations.updateCollaborationWorkspace, async ({ user, context, params, body }) => {
    return workspaces.updateSettings(user, context, collaborationWorkspaceId(params), body);
  });

  route(apiOperations.getCollaborationWorkspaceDeletionImpact, async ({ user, params }) => {
    return workspaces.getDeletionImpact(user, collaborationWorkspaceId(params));
  });

  route(apiOperations.deleteCollaborationWorkspace, async ({ user, context, params, body }) => {
    return workspaces.deleteSharedWorkspace(
      user,
      context,
      collaborationWorkspaceId(params),
      body.confirmName
    );
  });

  route(apiOperations.listCollaborationWorkspaceMembers, async ({ user, params }) => {
    return workspaces.listMembers(user, collaborationWorkspaceId(params));
  });

  route(
    apiOperations.listCollaborationWorkspaceMemberCandidates,
    async ({ user, params, query }) => {
      return workspaces.searchMemberCandidates(
        user,
        collaborationWorkspaceId(params),
        query.q ?? ""
      );
    }
  );

  route(apiOperations.addCollaborationWorkspaceMember, async ({ user, context, params, body }) => {
    return workspaces.addMemberByEmail(user, context, collaborationWorkspaceId(params), body.email);
  });

  route(apiOperations.leaveCollaborationWorkspace, async ({ user, context, params }) => {
    return workspaces.leaveWorkspace(user, context, collaborationWorkspaceId(params));
  });

  route(
    apiOperations.updateCollaborationWorkspaceMemberRole,
    async ({ user, context, params, body }) => {
      const member = workspaceUserParams(params);
      return workspaces.changeMemberRole(
        user,
        context,
        member.collaborationWorkspaceId,
        member.userId,
        body.role
      );
    }
  );

  route(apiOperations.removeCollaborationWorkspaceMember, async ({ user, context, params }) => {
    const member = workspaceUserParams(params);
    return workspaces.removeMember(user, context, member.collaborationWorkspaceId, member.userId);
  });

  route(apiOperations.requestCollaborationWorkspaceAccess, async ({ user, context, params }) => {
    return workspaces.requestAccess(user, context, collaborationWorkspaceId(params));
  });

  route(apiOperations.listCollaborationWorkspaceAccessRequests, async ({ user, params }) => {
    return workspaces.listAccessRequests(user, collaborationWorkspaceId(params));
  });

  route(
    apiOperations.approveCollaborationWorkspaceAccessRequest,
    async ({ user, context, params }) => {
      const member = workspaceUserParams(params);
      return workspaces.approveAccessRequest(
        user,
        context,
        member.collaborationWorkspaceId,
        member.userId
      );
    }
  );

  route(
    apiOperations.declineCollaborationWorkspaceAccessRequest,
    async ({ user, context, params }) => {
      const member = workspaceUserParams(params);
      return workspaces.declineAccessRequest(
        user,
        context,
        member.collaborationWorkspaceId,
        member.userId
      );
    }
  );
}

function collaborationWorkspaceId(params: { collaborationWorkspaceId: string }) {
  return asCollaborationWorkspaceId(
    requirePathParam(params.collaborationWorkspaceId, "Missing Collaboration Workspace id")
  );
}

function workspaceUserParams(params: { collaborationWorkspaceId: string; userId: string }) {
  const userId = asUserId(requirePathParam(params.userId, "Missing user id"));
  return { collaborationWorkspaceId: collaborationWorkspaceId(params), userId };
}
