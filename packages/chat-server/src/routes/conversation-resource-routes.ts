import type { FastifyInstance } from "fastify";
import {
  apiOperations,
  type StructuredDataResourceResponse
} from "@vivd-catalyst/api-contract";
import {
  AppError,
  asStructuredDataResourceId,
  requireAuthScope
} from "@vivd-catalyst/core";
import { listConversationResources } from "../conversation-resources";
import { ConversationWorkflow } from "../conversation-workflow";
import { authenticateRequest, getConversationId } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConversationResourceRoutes(
  app: FastifyInstance,
  options: ChatServerOptions
): void {
  const conversations = new ConversationWorkflow(options);

  app.get(apiOperations.listConversationResources.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    const conversationId = getConversationId(request);
    await conversations.requireOwnedActiveConversation(conversationId, user);
    return listConversationResources({
      store: options.conversationStore,
      clientInstanceId: options.clientInstanceId,
      conversationId
    });
  });

  app.get(apiOperations.getStructuredDataResource.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    const conversationId = getConversationId(request);
    await conversations.requireOwnedActiveConversation(conversationId, user);
    const resource = await options.conversationStore.getStructuredDataResource({
      clientInstanceId: options.clientInstanceId,
      conversationId,
      structuredDataResourceId: asStructuredDataResourceId(
        getStructuredDataResourceId(request)
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

function getStructuredDataResourceId(request: { params: unknown }): string {
  const params = request.params as { structuredDataResourceId?: string };
  if (!params?.structuredDataResourceId) {
    throw new AppError("BAD_REQUEST", "Missing structured data resource id");
  }
  return params.structuredDataResourceId;
}
