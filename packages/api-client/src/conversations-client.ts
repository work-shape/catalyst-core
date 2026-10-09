import { apiOperations, type ConversationVisibility } from "@vivd-catalyst/api-contract";
import * as generatedSdk from "./generated/sdk.gen";
import type { ApiClientTransport, OperationRequestInput } from "./transport";

export function createConversationsClient(transport: ApiClientTransport) {
  const artifactContentPath = (conversationId: string, artifactId: string) =>
    apiOperations.getConversationArtifactContent.buildPath({
      params: { conversationId, artifactId }
    });

  const listForWorkspace = (collaborationWorkspaceId?: string) =>
    transport.unwrapJson(
      generatedSdk.listConversations({
        client: transport.generatedClient,
        ...(collaborationWorkspaceId === undefined ? {} : { query: { collaborationWorkspaceId } })
      }),
      apiOperations.listConversations.response.schema
    );

  return {
    list: (collaborationWorkspaceId?: string) =>
      listForWorkspace(
        typeof collaborationWorkspaceId === "string" ? collaborationWorkspaceId : undefined
      ),
    create: (input: OperationRequestInput<typeof apiOperations.createConversation> = {}) =>
      transport.unwrapJson(
        generatedSdk.createConversation({
          client: transport.generatedClient,
          body: apiOperations.createConversation.body.parse(input)
        }),
        apiOperations.createConversation.response.schema
      ),
    getThread: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.getConversationThread({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations.getConversationThread.response.schema
      ),
    listMessages: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.listConversationMessages({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations.listConversationMessages.response.schema
      ),
    generateTitle: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.generateConversationTitle({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations.generateConversationTitle.response.schema
      ),
    rename: (conversationId: string, title: string) =>
      transport.unwrapJson(
        generatedSdk.renameConversation({
          client: transport.generatedClient,
          path: { conversationId },
          body: apiOperations.renameConversation.body.parse({ title })
        }),
        apiOperations.renameConversation.response.schema
      ),
    move: (
      conversationId: string,
      collaborationWorkspaceId: string,
      visibility?: ConversationVisibility
    ) =>
      transport.unwrapJson(
        generatedSdk.moveConversation({
          client: transport.generatedClient,
          path: { conversationId },
          body: apiOperations.moveConversation.body.parse({
            collaborationWorkspaceId,
            visibility
          })
        }),
        apiOperations.moveConversation.response.schema
      ),
    delete: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.deleteConversation({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations.deleteConversation.response.schema
      ),
    resources: {
      list: (conversationId: string) =>
        transport.unwrapJson(
          generatedSdk.listConversationResources({
            client: transport.generatedClient,
            path: { conversationId }
          }),
          apiOperations.listConversationResources.response.schema
        ),
      getStructuredData: (conversationId: string, structuredDataResourceId: string) =>
        transport.unwrapJson(
          generatedSdk.getStructuredDataResource({
            client: transport.generatedClient,
            path: { conversationId, structuredDataResourceId }
          }),
          apiOperations.getStructuredDataResource.response.schema
        )
    },
    draftAttachments: {
      list: (conversationId: string) =>
        transport.unwrapJson(
          generatedSdk.listDraftAttachments({
            client: transport.generatedClient,
            path: { conversationId }
          }),
          apiOperations.listDraftAttachments.response.schema
        ),
      upload: (conversationId: string, file: File) =>
        transport.unwrapJson(
          generatedSdk.uploadDraftAttachment({
            client: transport.generatedClient,
            path: { conversationId },
            body: { file }
          }),
          apiOperations.uploadDraftAttachment.response.schema
        ),
      retry: (conversationId: string, attachmentId: string) =>
        transport.unwrapJson(
          generatedSdk.retryDraftAttachment({
            client: transport.generatedClient,
            path: { conversationId, attachmentId }
          }),
          apiOperations.retryDraftAttachment.response.schema
        ),
      delete: (conversationId: string, attachmentId: string) =>
        transport.unwrapJson(
          generatedSdk.deleteDraftAttachment({
            client: transport.generatedClient,
            path: { conversationId, attachmentId }
          }),
          apiOperations.deleteDraftAttachment.response.schema
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
          apiOperations.getConversationArtifactPreview.response.schema
        ),
      getAttachmentPreview: (conversationId: string, attachmentId: string) =>
        transport.unwrapJson(
          generatedSdk.getConversationAttachmentPreview({
            client: transport.generatedClient,
            path: { conversationId, attachmentId }
          }),
          apiOperations.getConversationAttachmentPreview.response.schema
        ),
      retryPreview: (conversationId: string, artifactId: string) =>
        transport.unwrapJson(
          generatedSdk.retryConversationArtifactPreview({
            client: transport.generatedClient,
            path: { conversationId, artifactId }
          }),
          apiOperations.retryConversationArtifactPreview.response.schema
        )
    }
  };
}
