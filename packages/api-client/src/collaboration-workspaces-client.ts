import type { EnsurePersonalCollaborationWorkspaceResponse } from "./generated/types.gen";
import {
  apiOperations,
  type LocaleCode,
  type WorkspaceMembershipRole
} from "@vivd-catalyst/api-contract";
import * as generatedSdk from "./generated/sdk.gen";
import type { ApiClientTransport, OperationRequestInput } from "./transport";

export function createCollaborationWorkspacesClient(transport: ApiClientTransport) {
  return {
    ensurePersonal: (): Promise<EnsurePersonalCollaborationWorkspaceResponse> =>
      transport.unwrapJson(
        generatedSdk.ensurePersonalCollaborationWorkspace({ client: transport.generatedClient }),
        apiOperations.ensurePersonalCollaborationWorkspace.response.schema
      ),
    list: () =>
      transport.unwrapList(
        (paging) =>
          generatedSdk.listCollaborationWorkspaces({
            client: transport.generatedClient,
            query: paging
          }),
        apiOperations.listCollaborationWorkspaces.response.schema
      ),
    create: (input: OperationRequestInput<typeof apiOperations.createCollaborationWorkspace>) =>
      transport.unwrapJson(
        generatedSdk.createCollaborationWorkspace({
          client: transport.generatedClient,
          body: apiOperations.createCollaborationWorkspace.body.parse(input)
        }),
        apiOperations.createCollaborationWorkspace.response.schema
      ),
    browseDirectory: () =>
      transport.unwrapList(
        (paging) =>
          generatedSdk.listCollaborationWorkspaceDirectory({
            client: transport.generatedClient,
            query: paging
          }),
        apiOperations.listCollaborationWorkspaceDirectory.response.schema
      ),
    get: (collaborationWorkspaceId: string) =>
      transport.unwrapJson(
        generatedSdk.getCollaborationWorkspace({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId }
        }),
        apiOperations.getCollaborationWorkspace.response.schema
      ),
    listAgents: async (collaborationWorkspaceId: string, locale?: LocaleCode) => {
      let defaultAgentName: string | undefined;
      const agents = await transport.unwrapList(async (paging) => {
        const result = await generatedSdk.listCollaborationWorkspaceAgents({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId },
          query: { locale, ...paging }
        });
        if (result.data) defaultAgentName = result.data.defaultAgentName;
        return result;
      }, apiOperations.listCollaborationWorkspaceAgents.response.schema);
      return { defaultAgentName, items: agents };
    },
    update: (
      collaborationWorkspaceId: string,
      input: OperationRequestInput<typeof apiOperations.updateCollaborationWorkspace>
    ) =>
      transport.unwrapJson(
        generatedSdk.updateCollaborationWorkspace({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId },
          body: apiOperations.updateCollaborationWorkspace.body.parse(input)
        }),
        apiOperations.updateCollaborationWorkspace.response.schema
      ),
    deletionImpact: (collaborationWorkspaceId: string) =>
      transport.unwrapJson(
        generatedSdk.getCollaborationWorkspaceDeletionImpact({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId }
        }),
        apiOperations.getCollaborationWorkspaceDeletionImpact.response.schema
      ),
    delete: (collaborationWorkspaceId: string, confirmName: string) =>
      transport.unwrapJson(
        generatedSdk.deleteCollaborationWorkspace({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId },
          body: apiOperations.deleteCollaborationWorkspace.body.parse({ confirmName })
        }),
        apiOperations.deleteCollaborationWorkspace.response.schema
      ),
    members: {
      list: (collaborationWorkspaceId: string) =>
        transport.unwrapList(
          (paging) =>
            generatedSdk.listCollaborationWorkspaceMembers({
              client: transport.generatedClient,
              path: { collaborationWorkspaceId },
              query: paging
            }),
          apiOperations.listCollaborationWorkspaceMembers.response.schema
        ),
      searchCandidates: (collaborationWorkspaceId: string, query: string) =>
        transport.unwrapList(
          (paging) =>
            generatedSdk.listCollaborationWorkspaceMemberCandidates({
              client: transport.generatedClient,
              path: { collaborationWorkspaceId },
              query: { q: query, ...paging }
            }),
          apiOperations.listCollaborationWorkspaceMemberCandidates.response.schema
        ),
      addByEmail: (collaborationWorkspaceId: string, email: string) =>
        transport.unwrapJson(
          generatedSdk.addCollaborationWorkspaceMember({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId },
            body: apiOperations.addCollaborationWorkspaceMember.body.parse({ email })
          }),
          apiOperations.addCollaborationWorkspaceMember.response.schema
        ),
      changeRole: (
        collaborationWorkspaceId: string,
        userId: string,
        role: WorkspaceMembershipRole
      ) =>
        transport.unwrapJson(
          generatedSdk.updateCollaborationWorkspaceMemberRole({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId },
            body: apiOperations.updateCollaborationWorkspaceMemberRole.body.parse({ role })
          }),
          apiOperations.updateCollaborationWorkspaceMemberRole.response.schema
        ),
      remove: (collaborationWorkspaceId: string, userId: string) =>
        transport.unwrapJson(
          generatedSdk.removeCollaborationWorkspaceMember({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId }
          }),
          apiOperations.removeCollaborationWorkspaceMember.response.schema
        ),
      leave: (collaborationWorkspaceId: string) =>
        transport.unwrapJson(
          generatedSdk.leaveCollaborationWorkspace({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId }
          }),
          apiOperations.leaveCollaborationWorkspace.response.schema
        )
    },
    accessRequests: {
      create: (collaborationWorkspaceId: string) =>
        transport.unwrapJson(
          generatedSdk.requestCollaborationWorkspaceAccess({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId }
          }),
          apiOperations.requestCollaborationWorkspaceAccess.response.schema
        ),
      list: (collaborationWorkspaceId: string) =>
        transport.unwrapList(
          (paging) =>
            generatedSdk.listCollaborationWorkspaceAccessRequests({
              client: transport.generatedClient,
              path: { collaborationWorkspaceId },
              query: paging
            }),
          apiOperations.listCollaborationWorkspaceAccessRequests.response.schema
        ),
      approve: (collaborationWorkspaceId: string, userId: string) =>
        transport.unwrapJson(
          generatedSdk.approveCollaborationWorkspaceAccessRequest({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId }
          }),
          apiOperations.approveCollaborationWorkspaceAccessRequest.response.schema
        ),
      decline: (collaborationWorkspaceId: string, userId: string) =>
        transport.unwrapJson(
          generatedSdk.declineCollaborationWorkspaceAccessRequest({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId }
          }),
          apiOperations.declineCollaborationWorkspaceAccessRequest.response.schema
        )
    }
  };
}
