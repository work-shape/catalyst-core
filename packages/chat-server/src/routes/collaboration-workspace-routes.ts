import { paginate, pageScope } from "../http/paging";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { createSafeConfigView } from "@vivd-catalyst/config-schema";
import { asCollaborationWorkspaceId, asUserId, getSubjectUserId } from "@vivd-catalyst/core";
import { CollaborationWorkspaceWorkflow } from "../collaboration-workspace-workflow";
import type { Route } from "../http/route";
import { deletionAnswer } from "./deletion-answer";
import { requirePathParam, resolveRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerCollaborationWorkspaceRoutes(
  route: Route,
  options: ChatServerOptions
): void {
  const workspaces = new CollaborationWorkspaceWorkflow(options);

  route(apiOperations["workspaces.ensure_personal"], async ({ user }) => {
    const workspace = await options.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId: options.clientInstanceId,
      userId: asUserId(getSubjectUserId(user))
    });
    return workspaces.getWorkspace(user, workspace.id);
  });

  route(apiOperations["workspaces.list"], async ({ user }) => {
    return workspaces.listWorkspaces(user);
  });

  route(apiOperations["workspaces.create"], async ({ user, context, body }) => {
    return workspaces.createSharedWorkspace(user, context, body);
  });

  route(apiOperations["workspaces.directory.list"], async ({ user }) => {
    return workspaces.browseDirectory(user);
  });

  route(apiOperations["workspaces.get"], async ({ user, params }) => {
    return workspaces.getWorkspace(user, collaborationWorkspaceId(params));
  });

  route(apiOperations["workspaces.agents.list"], async ({ user, params, request, query }) => {
    const assets = await workspaces.getAssetSnapshot(user, collaborationWorkspaceId(params));
    const { defaultAgentName, agents } = createSafeConfigView(
      options.config,
      assets,
      options.modules,
      {
        requestedLocale: resolveRequestLocale(options, request),
        reasoningEffortsOfBinding: (bindingId) =>
          options.modelGateway.capabilities({ bindingId }).reasoningEfforts
      }
    );
    return {
      defaultAgentName,
      ...paginate(
        agents,
        query,
        ["name"],
        false,
        pageScope(apiOperations["workspaces.agents.list"].id, params, query)
      )
    };
  });

  route(apiOperations["workspaces.update"], async ({ user, context, params, body }) => {
    return workspaces.updateSettings(user, context, collaborationWorkspaceId(params), body);
  });

  route(apiOperations["workspaces.deletion_impact.get"], async ({ user, params }) => {
    return workspaces.getDeletionImpact(user, collaborationWorkspaceId(params));
  });

  route(apiOperations["workspaces.delete"], async ({ user, context, params, body }) => {
    return deletionAnswer(
      await workspaces.deleteSharedWorkspace(
        user,
        context,
        collaborationWorkspaceId(params),
        body.confirmName
      )
    );
  });

  route(apiOperations["workspaces.members.list"], async ({ user, params }) => {
    return workspaces.listMembers(user, collaborationWorkspaceId(params));
  });

  route(apiOperations["workspaces.member_candidates.list"], async ({ user, params, query }) => {
    return workspaces.searchMemberCandidates(user, collaborationWorkspaceId(params), query.q ?? "");
  });

  route(apiOperations["workspaces.members.add"], async ({ user, context, params, body }) => {
    return workspaces.addMemberByEmail(user, context, collaborationWorkspaceId(params), body.email);
  });

  route(apiOperations["workspaces.members.leave"], async ({ user, context, params }) => {
    return workspaces.leaveWorkspace(user, context, collaborationWorkspaceId(params));
  });

  route(
    apiOperations["workspaces.members.update_role"],
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

  route(apiOperations["workspaces.members.remove"], async ({ user, context, params }) => {
    const member = workspaceUserParams(params);
    return workspaces.removeMember(user, context, member.collaborationWorkspaceId, member.userId);
  });

  route(apiOperations["workspaces.access_requests.create"], async ({ user, context, params }) => {
    return workspaces.requestAccess(user, context, collaborationWorkspaceId(params));
  });

  route(apiOperations["workspaces.access_requests.list"], async ({ user, params }) => {
    return workspaces.listAccessRequests(user, collaborationWorkspaceId(params));
  });

  route(apiOperations["workspaces.access_requests.approve"], async ({ user, context, params }) => {
    const member = workspaceUserParams(params);
    return workspaces.approveAccessRequest(
      user,
      context,
      member.collaborationWorkspaceId,
      member.userId
    );
  });

  route(apiOperations["workspaces.access_requests.decline"], async ({ user, context, params }) => {
    const member = workspaceUserParams(params);
    return workspaces.declineAccessRequest(
      user,
      context,
      member.collaborationWorkspaceId,
      member.userId
    );
  });
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
