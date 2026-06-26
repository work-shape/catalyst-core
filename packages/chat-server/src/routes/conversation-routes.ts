import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { ConversationWorkflow } from "../conversation-workflow";
import type { ChatServerOptions } from "../types";
import { authenticateRequest, getConversationId, parseBody, withRequestLocale } from "../request-context";

export function registerConversationRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  app.get(apiOperations.listConversations.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    return conversations.listConversations(user);
  });

  app.post(apiOperations.createConversation.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(apiOperations.createConversation.requestSchema, request.body);
    return conversations.createConversation(
      user,
      withRequestLocale(context, options, request, body.locale),
      body
    );
  });

  app.get(apiOperations.listConversationMessages.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    return conversations.listMessages(getConversationId(request), user);
  });

  app.get(apiOperations.getConversationThread.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    return conversations.getThreadSnapshot(getConversationId(request), user);
  });

  app.delete(apiOperations.deleteConversation.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    return conversations.deleteConversation(getConversationId(request), user, context);
  });
}
