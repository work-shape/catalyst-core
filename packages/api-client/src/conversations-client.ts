import { apiOperations } from "@vivd-catalyst/api-contract";
import * as generatedSdk from "./generated/sdk.gen";
import type { ApiClientTransport, OperationRequestInput } from "./transport";

export function createConversationsClient(transport: ApiClientTransport) {
  const artifactContentPath = (conversationId: string, artifactId: string) =>
    apiOperations.getConversationArtifactContent.buildPath({
      params: { conversationId, artifactId }
    });

  const listForWorkspace = (collaborationWorkspaceId: string) =>
    transport.unwrapJson(
      generatedSdk.listConversations({
        client: transport.generatedClient,
        query: { collaborationWorkspaceId }
      }),
      apiOperations.listConversations.responseSchema
    );

  return {
    list: async (collaborationWorkspaceId?: unknown) => {
      if (typeof collaborationWorkspaceId === "string") {
        return listForWorkspace(collaborationWorkspaceId);
      }
      const workspaces = await transport.unwrapJson(
        generatedSdk.listCollaborationWorkspaces({ client: transport.generatedClient }),
        apiOperations.listCollaborationWorkspaces.responseSchema
      );
      const personalWorkspace = workspaces.find((workspace) => workspace.kind === "personal");
      if (!personalWorkspace) {
        throw new Error("Personal Workspace is not available");
      }
      return listForWorkspace(personalWorkspace.id);
    },
    create: (input: OperationRequestInput<typeof apiOperations.createConversation> = {}) =>
      transport.unwrapJson(
        generatedSdk.createConversation({
          client: transport.generatedClient,
          body: apiOperations.createConversation.requestSchema.parse(input)
        }),
        apiOperations.createConversation.responseSchema
      ),
    getThread: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.getConversationThread({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations.getConversationThread.responseSchema
      ),
    listMessages: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.listConversationMessages({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations.listConversationMessages.responseSchema
      ),
    generateTitle: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.generateConversationTitle({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations.generateConversationTitle.responseSchema
      ),
    rename: (conversationId: string, title: string) =>
      transport.unwrapJson(
        generatedSdk.renameConversation({
          client: transport.generatedClient,
          path: { conversationId },
          body: apiOperations.renameConversation.requestSchema.parse({ title })
        }),
        apiOperations.renameConversation.responseSchema
      ),
    move: (conversationId: string, collaborationWorkspaceId: string) =>
      transport.unwrapJson(
        generatedSdk.moveConversation({
          client: transport.generatedClient,
          path: { conversationId },
          body: apiOperations.moveConversation.requestSchema.parse({ collaborationWorkspaceId })
        }),
        apiOperations.moveConversation.responseSchema
      ),
    delete: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.deleteConversation({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations.deleteConversation.responseSchema
      ),
    resources: {
      list: (conversationId: string) =>
        transport.unwrapJson(
          generatedSdk.listConversationResources({
            client: transport.generatedClient,
            path: { conversationId }
          }),
          apiOperations.listConversationResources.responseSchema
        ),
      getStructuredData: (conversationId: string, structuredDataResourceId: string) =>
        transport.unwrapJson(
          generatedSdk.getStructuredDataResource({
            client: transport.generatedClient,
            path: { conversationId, structuredDataResourceId }
          }),
          apiOperations.getStructuredDataResource.responseSchema
        )
    },
    draftAttachments: {
      list: (conversationId: string) =>
        transport.unwrapJson(
          generatedSdk.listDraftAttachments({
            client: transport.generatedClient,
            path: { conversationId }
          }),
          apiOperations.listDraftAttachments.responseSchema
        ),
      upload: (conversationId: string, file: File) =>
        transport.unwrapJson(
          generatedSdk.uploadDraftAttachment({
            client: transport.generatedClient,
            path: { conversationId },
            body: { file }
          }),
          apiOperations.uploadDraftAttachment.responseSchema
        ),
      retry: (conversationId: string, attachmentId: string) =>
        transport.unwrapJson(
          generatedSdk.retryDraftAttachment({
            client: transport.generatedClient,
            path: { conversationId, attachmentId }
          }),
          apiOperations.retryDraftAttachment.responseSchema
        ),
      delete: (conversationId: string, attachmentId: string) =>
        transport.unwrapJson(
          generatedSdk.deleteDraftAttachment({
            client: transport.generatedClient,
            path: { conversationId, attachmentId }
          }),
          apiOperations.deleteDraftAttachment.responseSchema
        )
    },
    files: {
      getContent: (conversationId: string, fileId: string, download = false) =>
        transport.unwrapBlob(
          generatedSdk.getConversationFileContent({
            client: transport.generatedClient,
            path: { conversationId, fileId },
            query: download ? { download: "true" } : {},
            parseAs: "blob"
          })
        ),
      contentUrl: (conversationId: string, fileId: string) =>
        transport.buildUrl(
          apiOperations.getConversationFileContent.buildPath({
            params: { conversationId, fileId }
          })
        )
    },
    artifacts: {
      getContent: (conversationId: string, artifactId: string) =>
        transport.unwrapBlob(
          generatedSdk.getConversationArtifactContent({
            client: transport.generatedClient,
            path: { conversationId, artifactId },
            parseAs: "blob"
          })
        ),
      contentUrl: (conversationId: string, artifactId: string, inline = false) =>
        transport.buildUrl(
          `${artifactContentPath(conversationId, artifactId)}${inline ? "?inline=true" : ""}`
        ),
      getPreview: (conversationId: string, artifactId: string) =>
        transport.unwrapJson(
          generatedSdk.getConversationArtifactPreview({
            client: transport.generatedClient,
            path: { conversationId, artifactId }
          }),
          apiOperations.getConversationArtifactPreview.responseSchema
        ),
      getAttachmentPreview: (conversationId: string, attachmentId: string) =>
        transport.unwrapJson(
          generatedSdk.getConversationAttachmentPreview({
            client: transport.generatedClient,
            path: { conversationId, attachmentId }
          }),
          apiOperations.getConversationAttachmentPreview.responseSchema
        ),
      retryPreview: (conversationId: string, artifactId: string) =>
        transport.unwrapJson(
          generatedSdk.retryConversationArtifactPreview({
            client: transport.generatedClient,
            path: { conversationId, artifactId }
          }),
          apiOperations.retryConversationArtifactPreview.responseSchema
        )
    }
  };
}
