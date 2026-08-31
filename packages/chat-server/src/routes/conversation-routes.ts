import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, asCollaborationWorkspaceId, requireAuthScope } from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import type { ChatServerOptions } from "../types";
import {
  authenticateRequest,
  getConversationId,
  parseBody,
  withRequestLocale
} from "../request-context";

export function registerConversationRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  app.get(apiOperations.listConversations.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    const collaborationWorkspaceId = (request.query as { collaborationWorkspaceId?: string })
      .collaborationWorkspaceId;
    if (collaborationWorkspaceId === "") {
      throw new AppError("BAD_REQUEST", "Missing collaborationWorkspaceId query parameter");
    }
    return conversations.listConversations(
      collaborationWorkspaceId === undefined
        ? undefined
        : asCollaborationWorkspaceId(collaborationWorkspaceId),
      user
    );
  });

  app.post(apiOperations.createConversation.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    const body = parseBody(apiOperations.createConversation.requestSchema, request.body);
    return conversations.createConversation(
      user,
      withRequestLocale(context, options, request, body.locale),
      {
        title: body.title,
        collaborationWorkspaceId: body.collaborationWorkspaceId
          ? asCollaborationWorkspaceId(body.collaborationWorkspaceId)
          : undefined
      }
    );
  });

  app.get(apiOperations.listConversationMessages.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    return conversations.listMessages(getConversationId(request), user);
  });

  app.get(apiOperations.getConversationThread.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    return conversations.getThreadSnapshot(getConversationId(request), user);
  });

  app.patch(apiOperations.renameConversation.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    const body = parseBody(apiOperations.renameConversation.requestSchema, request.body);
    return conversations.renameConversation(getConversationId(request), body.title, user, context);
  });

  app.post(apiOperations.moveConversation.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    const body = parseBody(apiOperations.moveConversation.requestSchema, request.body);
    return conversations.moveConversation(getConversationId(request), user, context, {
      collaborationWorkspaceId: asCollaborationWorkspaceId(body.collaborationWorkspaceId)
    });
  });

  app.delete(apiOperations.deleteConversation.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    return conversations.deleteConversation(getConversationId(request), user, context);
  });
}
