import type {
  ConversationsArtifactsStartPreviewResponse,
  ConversationsAttachmentsStartPreviewResponse
} from "./generated/types.gen";
import { apiOperations, type ConversationVisibility } from "@vivd-catalyst/api-contract";
import * as generatedSdk from "./generated/sdk.gen";
import type { ApiClientTransport, OperationRequestInput } from "./transport";

export function createConversationsClient(transport: ApiClientTransport) {
  const artifactContentPath = (conversationId: string, artifactId: string) =>
    apiOperations["conversations.artifacts.get_content"].buildPath({
      params: { conversationId, artifactId }
    });

  const listForWorkspace = (collaborationWorkspaceId?: string) =>
    transport.unwrapList(
      (paging) =>
        generatedSdk.conversationsList({
          client: transport.generatedClient,
          query: { collaborationWorkspaceId, ...paging }
        }),
      apiOperations["conversations.list"].response.schema
    );

  return {
    list: (collaborationWorkspaceId?: string) =>
      listForWorkspace(
        typeof collaborationWorkspaceId === "string" ? collaborationWorkspaceId : undefined
      ),
    create: (input: OperationRequestInput<(typeof apiOperations)["conversations.create"]> = {}) =>
      transport.unwrapJson(
        generatedSdk.conversationsCreate({
          client: transport.generatedClient,
          body: apiOperations["conversations.create"].body.parse(input)
        }),
        apiOperations["conversations.create"].response.schema
      ),
    getThread: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.conversationsThreadGet({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations["conversations.thread.get"].response.schema
      ),
    listMessages: (conversationId: string) =>
      transport.unwrapList(
        (paging) =>
          generatedSdk.conversationsMessagesList({
            client: transport.generatedClient,
            path: { conversationId },
            query: paging
          }),
        apiOperations["conversations.messages.list"].response.schema
      ),
    generateTitle: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.conversationsTitleGenerate({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations["conversations.title.generate"].response.schema
      ),
    rename: (conversationId: string, title: string) =>
      transport.unwrapJson(
        generatedSdk.conversationsRename({
          client: transport.generatedClient,
          path: { conversationId },
          body: apiOperations["conversations.rename"].body.parse({ title })
        }),
        apiOperations["conversations.rename"].response.schema
      ),
    move: (
      conversationId: string,
      collaborationWorkspaceId: string,
      visibility?: ConversationVisibility
    ) =>
      transport.unwrapJson(
        generatedSdk.conversationsMove({
          client: transport.generatedClient,
          path: { conversationId },
          body: apiOperations["conversations.move"].body.parse({
            collaborationWorkspaceId,
            visibility
          })
        }),
        apiOperations["conversations.move"].response.schema
      ),
    delete: (conversationId: string) =>
      transport.unwrapJson(
        generatedSdk.conversationsDelete({
          client: transport.generatedClient,
          path: { conversationId }
        }),
        apiOperations["conversations.delete"].response.schema
      ),
    resources: {
      list: (conversationId: string) =>
        transport.unwrapList(
          (paging) =>
            generatedSdk.conversationsResourcesList({
              client: transport.generatedClient,
              path: { conversationId },
              query: paging
            }),
          apiOperations["conversations.resources.list"].response.schema
        ),
      getStructuredData: (conversationId: string, structuredDataResourceId: string) =>
        transport.unwrapJson(
          generatedSdk.conversationsStructuredDataGet({
            client: transport.generatedClient,
            path: { conversationId, structuredDataResourceId }
          }),
          apiOperations["conversations.structured_data.get"].response.schema
        )
    },
    draftAttachments: {
      list: (conversationId: string) =>
        transport.unwrapList(
          (paging) =>
            generatedSdk.conversationsDraftAttachmentsList({
              client: transport.generatedClient,
              path: { conversationId },
              query: paging
            }),
          apiOperations["conversations.draft_attachments.list"].response.schema
        ),
      upload: (conversationId: string, file: File) =>
        transport.unwrapJson(
          generatedSdk.conversationsDraftAttachmentsUpload({
            client: transport.generatedClient,
            path: { conversationId },
            body: { file }
          }),
          apiOperations["conversations.draft_attachments.upload"].response.schema
        ),
      retry: (conversationId: string, attachmentId: string) =>
        transport.unwrapJson(
          generatedSdk.conversationsDraftAttachmentsRetry({
            client: transport.generatedClient,
            path: { conversationId, attachmentId }
          }),
          apiOperations["conversations.draft_attachments.retry"].response.schema
        ),
      delete: (conversationId: string, attachmentId: string) =>
        transport.unwrapJson(
          generatedSdk.conversationsDraftAttachmentsDelete({
            client: transport.generatedClient,
            path: { conversationId, attachmentId }
          }),
          apiOperations["conversations.draft_attachments.delete"].response.schema
        )
    },
    files: {
      getContent: (conversationId: string, fileId: string, download = false) =>
        transport.unwrapBlob(
          generatedSdk.conversationsFilesGetContent({
            client: transport.generatedClient,
            path: { conversationId, fileId },
            query: download ? { download: "true" } : {},
            parseAs: "blob"
          })
        ),
      contentUrl: (conversationId: string, fileId: string) =>
        transport.buildUrl(
          apiOperations["conversations.files.get_content"].buildPath({
            params: { conversationId, fileId }
          })
        )
    },
    artifacts: {
      startPreview: (
        conversationId: string,
        artifactId: string
      ): Promise<ConversationsArtifactsStartPreviewResponse> =>
        transport.unwrapJson(
          generatedSdk.conversationsArtifactsStartPreview({
            client: transport.generatedClient,
            path: { conversationId, artifactId }
          }),
          apiOperations["conversations.artifacts.start_preview"].response.schema
        ),
      startAttachmentPreview: (
        conversationId: string,
        attachmentId: string
      ): Promise<ConversationsAttachmentsStartPreviewResponse> =>
        transport.unwrapJson(
          generatedSdk.conversationsAttachmentsStartPreview({
            client: transport.generatedClient,
            path: { conversationId, attachmentId }
          }),
          apiOperations["conversations.attachments.start_preview"].response.schema
        ),

      getContent: (conversationId: string, artifactId: string) =>
        transport.unwrapBlob(
          generatedSdk.conversationsArtifactsGetContent({
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
          generatedSdk.conversationsArtifactsGetPreview({
            client: transport.generatedClient,
            path: { conversationId, artifactId }
          }),
          apiOperations["conversations.artifacts.get_preview"].response.schema
        ),
      getAttachmentPreview: (conversationId: string, attachmentId: string) =>
        transport.unwrapJson(
          generatedSdk.conversationsAttachmentsGetPreview({
            client: transport.generatedClient,
            path: { conversationId, attachmentId }
          }),
          apiOperations["conversations.attachments.get_preview"].response.schema
        ),
      retryPreview: (conversationId: string, artifactId: string) =>
        transport.unwrapJson(
          generatedSdk.conversationsArtifactsRetryPreview({
            client: transport.generatedClient,
            path: { conversationId, artifactId }
          }),
          apiOperations["conversations.artifacts.retry_preview"].response.schema
        )
    }
  };
}
