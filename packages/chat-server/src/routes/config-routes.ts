import type { FastifyInstance } from "fastify";
import { createClientBranding, createSafeConfigView } from "@agent-chat-platform/config-schema";
import type { ChatServerOptions } from "../types";
import { authenticateRequest } from "../request-context";

export function registerConfigRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  app.get("/api/me", async (request) => {
    const { user } = await authenticateRequest(options, request);
    return user;
  });

  app.get("/api/branding", async () => createClientBranding(options.config));

  app.get("/api/config", async (request) => {
    await authenticateRequest(options, request);
    return createSafeConfigView(options.config);
  });
}
