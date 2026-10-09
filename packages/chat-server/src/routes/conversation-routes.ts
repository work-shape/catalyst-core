import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, asCollaborationWorkspaceId } from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import type { Route } from "../http/route";
import { conversationIdParam, withRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConversationRoutes(route: Route, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  route(apiOperations.listConversations, ({ user, query, paging }) => {
    const { collaborationWorkspaceId } = query;
    if (collaborationWorkspaceId === "") {
      throw new AppError("BAD_REQUEST", "Missing collaborationWorkspaceId query parameter");
    }
    return conversations.listConversations(
      collaborationWorkspaceId === undefined
        ? undefined
        : asCollaborationWorkspaceId(collaborationWorkspaceId),
      user,
      paging
    );
  });

  route(apiOperations.createConversation, ({ user, context, body, request }) =>
    conversations.createConversation(
      user,
      withRequestLocale(context, options, request, body.locale),
      {
        title: body.title,
        collaborationWorkspaceId: body.collaborationWorkspaceId
          ? asCollaborationWorkspaceId(body.collaborationWorkspaceId)
          : undefined
      }
    )
  );

  route(apiOperations.listConversationMessages, ({ user, params }) =>
    conversations.listMessages(conversationIdParam(params), user)
  );

  route(apiOperations.getConversationThread, ({ user, params }) =>
    conversations.getThreadSnapshot(conversationIdParam(params), user)
  );

  route(apiOperations.renameConversation, ({ user, context, params, body }) =>
    conversations.renameConversation(conversationIdParam(params), body.title, user, context)
  );

  route(apiOperations.moveConversation, ({ user, context, params, body }) =>
    conversations.moveConversation(conversationIdParam(params), user, context, {
      collaborationWorkspaceId: asCollaborationWorkspaceId(body.collaborationWorkspaceId),
      visibility: body.visibility
    })
  );

  route(apiOperations.deleteConversation, ({ user, context, params }) =>
    conversations.deleteConversation(conversationIdParam(params), user, context)
  );
}
