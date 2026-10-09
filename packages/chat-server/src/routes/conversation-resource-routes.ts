import { apiOperations, type StructuredDataResourceResponse } from "@vivd-catalyst/api-contract";
import { AppError, asStructuredDataResourceId } from "@vivd-catalyst/core";
import { listConversationResources } from "../conversation-resources";
import { ConversationWorkflow } from "../conversation-workflow";
import type { Route } from "../http/route";
import { conversationIdParam, requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConversationResourceRoutes(route: Route, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  route(apiOperations.listConversationResources, async ({ user, params }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    return listConversationResources({
      store: options.conversationStore,
      clientInstanceId: options.clientInstanceId,
      conversationId
    });
  });

  route(apiOperations.getStructuredDataResource, async ({ user, params }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const resource = await options.conversationStore.getStructuredDataResource({
      clientInstanceId: options.clientInstanceId,
      conversationId,
      structuredDataResourceId: asStructuredDataResourceId(
        requirePathParam(params.structuredDataResourceId, "Missing structured data resource id")
      )
    });
    if (!resource) {
      throw new AppError("NOT_FOUND", "Structured data resource is not available");
    }
    const attachments = await options.conversationStore.listSentConversationAttachments({
      clientInstanceId: options.clientInstanceId,
      conversationId
    });
    const filenames = new Map(
      attachments.map((attachment) => [attachment.id, attachment.filename])
    );
    return {
      id: resource.id,
      resourceKey: resource.resourceKey,
      title: resource.title,
      revision: resource.revision,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
      sections: resource.state.sections.map((section) => ({
        key: section.key,
        label: section.label,
        fields: section.fields.map((field) => ({
          key: field.key,
          label: field.label,
          value: field.value,
          ...(field.attention ? { attention: field.attention } : {}),
          ...(field.sources
            ? {
                sources: field.sources.flatMap((source) => {
                  const filename = filenames.get(source.attachmentId);
                  return filename
                    ? [
                        {
                          attachmentId: source.attachmentId,
                          ...(source.page !== undefined ? { page: source.page } : {}),
                          filename
                        }
                      ]
                    : [];
                })
              }
            : {})
        }))
      }))
    } satisfies StructuredDataResourceResponse;
  });
}
