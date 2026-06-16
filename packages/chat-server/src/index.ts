import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { installErrorHandler } from "./errors";
import { registerAuditRoutes } from "./routes/audit-routes";
import { registerBetterAuthRoutes } from "./routes/better-auth-routes";
import { registerChatStreamRoutes } from "./routes/chat-stream-routes";
import { registerConfigRoutes } from "./routes/config-routes";
import { registerConversationFileRoutes } from "./routes/conversation-file-routes";
import { registerConversationRoutes } from "./routes/conversation-routes";
import { registerDraftAttachmentRoutes } from "./routes/draft-attachment-routes";
import { registerSessionTokenRoutes } from "./routes/session-token-routes";
import { registerSuperadminRoutes } from "./routes/superadmin-routes";
import { registerUserAccountRoutes } from "./routes/user-account-routes";
import type { ChatServerOptions } from "./types";

export type { ChatServerOptions } from "./types";

export async function createChatServer(options: ChatServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: options.corsOrigin ?? true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "x-correlation-id", "x-server-credential"]
  });
  await app.register(multipart, {
    limits: {
      fileSize: options.config.documents.preprocessing.maxFileBytes
    }
  });

  installErrorHandler(app);

  app.get("/health", async () => ({
    status: "ok",
    clientInstanceId: options.clientInstanceId,
    time: new Date().toISOString()
  }));

  registerBetterAuthRoutes(app, options);
  registerSessionTokenRoutes(app, options);
  registerChatStreamRoutes(app, options);
  registerConfigRoutes(app, options);
  registerUserAccountRoutes(app, options);
  registerConversationRoutes(app, options);
  registerConversationFileRoutes(app, options);
  registerDraftAttachmentRoutes(app, options);
  registerAuditRoutes(app, options);
  registerSuperadminRoutes(app, options);

  return app;
}
