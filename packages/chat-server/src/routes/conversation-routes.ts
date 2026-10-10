import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, asCollaborationWorkspaceId } from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversations/conversation-workflow";
import { RunObservationWorkflow } from "../conversations/run-observation-workflow";
import type { Route } from "../http/route";
import { conversationIdParam, withRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConversationRoutes(route: Route, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);
  const runObservation = new RunObservationWorkflow(options);

  route(apiOperations["conversations.list"], ({ user, query, paging }) => {
    const { collaborationWorkspaceId } = query;
    if (collaborationWorkspaceId === "") {
      throw new AppError("BAD_REQUEST", "Missing collaborationWorkspaceId query parameter");
    }
    return conversations.listConversations(
      collaborationWorkspaceId === undefined
        ? undefined
        : asCollaborationWorkspaceId(collaborationWorkspaceId),
      user,
      paging,
      query.query
    );
  });

  route(apiOperations["conversations.create"], ({ user, context, body, request }) =>
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

  route(apiOperations["conversations.messages.list"], ({ user, params }) =>
    runObservation.listMessages(conversationIdParam(params), user)
  );

  route(apiOperations["conversations.thread.get"], ({ user, params }) =>
    runObservation.getThreadSnapshot(conversationIdParam(params), user)
  );

  route(apiOperations["conversations.rename"], ({ user, context, params, body }) =>
    conversations.renameConversation(conversationIdParam(params), body.title, user, context)
  );

  route(apiOperations["conversations.move"], ({ user, context, params, body }) =>
    conversations.moveConversation(conversationIdParam(params), user, context, {
      collaborationWorkspaceId: asCollaborationWorkspaceId(body.collaborationWorkspaceId),
      visibility: body.visibility
    })
  );

  route(apiOperations["conversations.delete"], ({ user, context, params }) =>
    conversations.deleteConversation(conversationIdParam(params), user, context)
  );
}
