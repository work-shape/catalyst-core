import { apiOperations, type WorkspaceMembershipRole } from "@vivd-catalyst/api-contract";
import * as generatedSdk from "./generated/sdk.gen";
import type { ApiClientTransport, OperationRequestInput } from "./transport";

export function createCollaborationWorkspacesClient(transport: ApiClientTransport) {
  return {
    list: () =>
      transport.unwrapJson(
        generatedSdk.listCollaborationWorkspaces({ client: transport.generatedClient }),
        apiOperations.listCollaborationWorkspaces.responseSchema
      ),
    create: (input: OperationRequestInput<typeof apiOperations.createCollaborationWorkspace>) =>
      transport.unwrapJson(
        generatedSdk.createCollaborationWorkspace({
          client: transport.generatedClient,
          body: apiOperations.createCollaborationWorkspace.requestSchema.parse(input)
        }),
        apiOperations.createCollaborationWorkspace.responseSchema
      ),
    browseDirectory: () =>
      transport.unwrapJson(
        generatedSdk.listCollaborationWorkspaceDirectory({
          client: transport.generatedClient
        }),
        apiOperations.listCollaborationWorkspaceDirectory.responseSchema
      ),
    get: (collaborationWorkspaceId: string) =>
      transport.unwrapJson(
        generatedSdk.getCollaborationWorkspace({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId }
        }),
        apiOperations.getCollaborationWorkspace.responseSchema
      ),
    update: (
      collaborationWorkspaceId: string,
      input: OperationRequestInput<typeof apiOperations.updateCollaborationWorkspace>
    ) =>
      transport.unwrapJson(
        generatedSdk.updateCollaborationWorkspace({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId },
          body: apiOperations.updateCollaborationWorkspace.requestSchema.parse(input)
        }),
        apiOperations.updateCollaborationWorkspace.responseSchema
      ),
    deletionImpact: (collaborationWorkspaceId: string) =>
      transport.unwrapJson(
        generatedSdk.getCollaborationWorkspaceDeletionImpact({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId }
        }),
        apiOperations.getCollaborationWorkspaceDeletionImpact.responseSchema
      ),
    delete: (collaborationWorkspaceId: string, confirmName: string) =>
      transport.unwrapJson(
        generatedSdk.deleteCollaborationWorkspace({
          client: transport.generatedClient,
          path: { collaborationWorkspaceId },
          body: apiOperations.deleteCollaborationWorkspace.requestSchema.parse({ confirmName })
        }),
        apiOperations.deleteCollaborationWorkspace.responseSchema
      ),
    members: {
      list: (collaborationWorkspaceId: string) =>
        transport.unwrapJson(
          generatedSdk.listCollaborationWorkspaceMembers({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId }
          }),
          apiOperations.listCollaborationWorkspaceMembers.responseSchema
        ),
      addByEmail: (collaborationWorkspaceId: string, email: string) =>
        transport.unwrapJson(
          generatedSdk.addCollaborationWorkspaceMember({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId },
            body: apiOperations.addCollaborationWorkspaceMember.requestSchema.parse({ email })
          }),
          apiOperations.addCollaborationWorkspaceMember.responseSchema
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
            body: apiOperations.updateCollaborationWorkspaceMemberRole.requestSchema.parse({ role })
          }),
          apiOperations.updateCollaborationWorkspaceMemberRole.responseSchema
        ),
      remove: (collaborationWorkspaceId: string, userId: string) =>
        transport.unwrapJson(
          generatedSdk.removeCollaborationWorkspaceMember({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId }
          }),
          apiOperations.removeCollaborationWorkspaceMember.responseSchema
        ),
      leave: (collaborationWorkspaceId: string) =>
        transport.unwrapJson(
          generatedSdk.leaveCollaborationWorkspace({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId }
          }),
          apiOperations.leaveCollaborationWorkspace.responseSchema
        )
    },
    accessRequests: {
      create: (collaborationWorkspaceId: string) =>
        transport.unwrapJson(
          generatedSdk.requestCollaborationWorkspaceAccess({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId }
          }),
          apiOperations.requestCollaborationWorkspaceAccess.responseSchema
        ),
      list: (collaborationWorkspaceId: string) =>
        transport.unwrapJson(
          generatedSdk.listCollaborationWorkspaceAccessRequests({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId }
          }),
          apiOperations.listCollaborationWorkspaceAccessRequests.responseSchema
        ),
      approve: (collaborationWorkspaceId: string, userId: string) =>
        transport.unwrapJson(
          generatedSdk.approveCollaborationWorkspaceAccessRequest({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId }
          }),
          apiOperations.approveCollaborationWorkspaceAccessRequest.responseSchema
        ),
      decline: (collaborationWorkspaceId: string, userId: string) =>
        transport.unwrapJson(
          generatedSdk.declineCollaborationWorkspaceAccessRequest({
            client: transport.generatedClient,
            path: { collaborationWorkspaceId, userId }
          }),
          apiOperations.declineCollaborationWorkspaceAccessRequest.responseSchema
        )
    }
  };
}
