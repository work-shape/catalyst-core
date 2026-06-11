import type { FastifyInstance } from "fastify";
import { createConversationRequestSchema } from "@vivd-stage/api-contract";
import { ConversationWorkflow } from "../conversation-workflow";
import type { ChatServerOptions } from "../types";
import { authenticateRequest, getConversationId, parseBody, withRequestLocale } from "../request-context";

export function registerConversationRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  app.get("/api/conversations", async (request) => {
    const { user } = await authenticateRequest(options, request);
    return conversations.listConversations(user);
  });

  app.post("/api/conversations", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(createConversationRequestSchema, request.body);
    return conversations.createConversation(
      user,
      withRequestLocale(context, options, request, body.locale),
      body
    );
  });

  app.get("/api/conversations/:conversationId/messages", async (request) => {
    const { user } = await authenticateRequest(options, request);
    return conversations.listMessages(getConversationId(request), user);
  });

  app.delete("/api/conversations/:conversationId", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    return conversations.deleteConversation(getConversationId(request), user, context);
  });
}
