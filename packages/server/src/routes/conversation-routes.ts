import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  asCollaborationWorkspaceId,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  isAuthenticatedServicePrincipal
} from "@work-shape/catalyst-core";
import { ConversationWorkflow } from "../conversations/conversation-service";
import { RunObservationWorkflow } from "../conversations/run-observation-service";
import type { Route } from "../http/route";
import { conversationIdParam, withRequestLocale } from "./request-context";
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
          : undefined,
        ...(body.subject ? { subject: body.subject } : {}),
        ...(body.visibility ? { visibility: body.visibility } : {})
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

  // The person's step that makes an asset what their conversation is about, recorded as an
  // Operation Run. The conversation's own rule decides who may take it, as for every route of a
  // conversation: only its creator, on an asset they may read, and anyone else reads "missing".
  route.operation(apiOperations["conversations.subject.open"], {
    changeClass: "reversible",
    authorize: (_input, { actor }) =>
      isAuthenticatedServicePrincipal(actor)
        ? { allowed: false, action: "conversations.subject.open", reason: "no_grant" }
        : { allowed: true },
    resource: ({ conversationId }) => ({ kind: "conversation", id: conversationId }),
    execute: ({ conversationId, kind, name, toolCallId }, context) =>
      conversations.openSubject(
        conversationIdParam({ conversationId }),
        personOf(context.actor),
        context,
        { kind, name, ...(toolCallId === undefined ? {} : { toolCallId }) }
      )
  });

  route(apiOperations["conversations.move"], ({ user, context, params, body }) =>
    conversations.moveConversation(conversationIdParam(params), user, context, {
      collaborationWorkspaceId: asCollaborationWorkspaceId(body.collaborationWorkspaceId),
      visibility: body.visibility
    })
  );

  route(apiOperations["conversations.delete"], ({ user, context, params, query }) =>
    conversations.deleteConversation(
      conversationIdParam(params),
      user,
      context,
      query.discardEmpty === "true"
    )
  );
}

function personOf(actor: AuthenticatedIdentity): AuthenticatedUser {
  if (isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", "Service principals cannot access user-scoped routes");
  }
  return actor;
}
