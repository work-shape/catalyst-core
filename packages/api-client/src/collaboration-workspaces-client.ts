import type { WorkspacesEnsurePersonalResponse } from "./generated/types.gen";
import {
  apiOperations,
  type LocaleCode,
  type WorkspaceMembershipRole
} from "@vivd-catalyst/api-contract";
import * as generatedSdk from "./generated/sdk.gen";
import type { ApiClientTransport, OperationRequestInput } from "./transport";

export function createCollaborationWorkspacesClient(transport: ApiClientTransport) {
  return {
    ensurePersonal: (): Promise<WorkspacesEnsurePersonalResponse> =>
      transport.unwrapJson(
        generatedSdk.workspacesEnsurePersonal({ client: transport.generatedClient }),
        apiOperations["workspaces.ensure_personal"].response.schema
      ),
    list: () =>
      transport.unwrapList(
        (paging) =>
          generatedSdk.workspacesList({
            client: transport.generatedClient,
            query: paging
          }),
        apiOperations["workspaces.list"].response.schema
      ),
    create: (input: OperationRequestInput<(typeof apiOperations)["workspaces.create"]>) =>
      transport.unwrapJson(
        generatedSdk.workspacesCreate({
          client: transport.generatedClient,
          body: apiOperations["workspaces.create"].body.parse(input)
        }),
        apiOperations["workspaces.create"].response.schema
      ),
    browseDirectory: () =>
      transport.unwrapList(
        (paging) =>
          generatedSdk.workspacesDirectoryList({
            client: transport.generatedClient,
            query: paging
          }),
        apiOperations["workspaces.directory.list"].response.schema
      ),
    get: (collaborationWorkspaceId: string) =>
      transport.unwrapJson(
        generatedSdk.workspacesGet({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId }
        }),
        apiOperations["workspaces.get"].response.schema
      ),
    listAgents: async (collaborationWorkspaceId: string, locale?: LocaleCode) => {
      let defaultAgentName: string | undefined;
      const agents = await transport.unwrapList(async (paging) => {
        const result = await generatedSdk.workspacesAgentsList({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId },
          query: { locale, ...paging }
        });
        if (result.data) defaultAgentName = result.data.defaultAgentName;
        return result;
      }, apiOperations["workspaces.agents.list"].response.schema);
      return { defaultAgentName, items: agents };
    },
    update: (
      collaborationWorkspaceId: string,
      input: OperationRequestInput<(typeof apiOperations)["workspaces.update"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.workspacesUpdate({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId },
          body: apiOperations["workspaces.update"].body.parse(input)
        }),
        apiOperations["workspaces.update"].response.schema
      ),
    deletionImpact: (collaborationWorkspaceId: string) =>
      transport.unwrapJson(
        generatedSdk.workspacesDeletionImpactGet({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId }
        }),
        apiOperations["workspaces.deletion_impact.get"].response.schema
      ),
    delete: (collaborationWorkspaceId: string, confirmName: string) =>
      transport.unwrapJson(
        generatedSdk.workspacesDelete({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId },
          body: apiOperations["workspaces.delete"].body.parse({ confirmName })
        }),
        apiOperations["workspaces.delete"].response.schema
      ),
    members: {
      list: (collaborationWorkspaceId: string) =>
        transport.unwrapList(
          (paging) =>
            generatedSdk.workspacesMembersList({
              client: transport.generatedClient,
              path: { collaborationWorkspaceId },
              query: paging
            }),
          apiOperations["workspaces.members.list"].response.schema
        ),
      searchCandidates: (collaborationWorkspaceId: string, query: string) =>
        transport.unwrapList(
          (paging) =>
            generatedSdk.workspacesMemberCandidatesList({
              client: transport.generatedClient,
              path: { collaborationWorkspaceId },
              query: { q: query, ...paging }
            }),
          apiOperations["workspaces.member_candidates.list"].response.schema
        ),
      addByEmail: (collaborationWorkspaceId: string, email: string) =>
        transport.unwrapJson(
          generatedSdk.workspacesMembersAdd({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId },
            body: apiOperations["workspaces.members.add"].body.parse({ email })
          }),
          apiOperations["workspaces.members.add"].response.schema
        ),
      changeRole: (
        collaborationWorkspaceId: string,
        userId: string,
        role: WorkspaceMembershipRole
      ) =>
        transport.unwrapJson(
          generatedSdk.workspacesMembersUpdateRole({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId },
            body: apiOperations["workspaces.members.update_role"].body.parse({ role })
          }),
          apiOperations["workspaces.members.update_role"].response.schema
        ),
      remove: (collaborationWorkspaceId: string, userId: string) =>
        transport.unwrapJson(
          generatedSdk.workspacesMembersRemove({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId }
          }),
          apiOperations["workspaces.members.remove"].response.schema
        ),
      leave: (collaborationWorkspaceId: string) =>
        transport.unwrapJson(
          generatedSdk.workspacesMembersLeave({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId }
          }),
          apiOperations["workspaces.members.leave"].response.schema
        )
    },
    accessRequests: {
      create: (collaborationWorkspaceId: string) =>
        transport.unwrapJson(
          generatedSdk.workspacesAccessRequestsCreate({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId }
          }),
          apiOperations["workspaces.access_requests.create"].response.schema
        ),
      list: (collaborationWorkspaceId: string) =>
        transport.unwrapList(
          (paging) =>
            generatedSdk.workspacesAccessRequestsList({
              client: transport.generatedClient,
              path: { collaborationWorkspaceId },
              query: paging
            }),
          apiOperations["workspaces.access_requests.list"].response.schema
        ),
      approve: (collaborationWorkspaceId: string, userId: string) =>
        transport.unwrapJson(
          generatedSdk.workspacesAccessRequestsApprove({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId }
          }),
          apiOperations["workspaces.access_requests.approve"].response.schema
        ),
      decline: (collaborationWorkspaceId: string, userId: string) =>
        transport.unwrapJson(
          generatedSdk.workspacesAccessRequestsDecline({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId }
          }),
          apiOperations["workspaces.access_requests.decline"].response.schema
        )
    }
  };
}
