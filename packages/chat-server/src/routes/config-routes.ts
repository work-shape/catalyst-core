import type { FastifyInstance } from "fastify";
import { createClientBranding, createSafeConfigView } from "@vivd-stage/config-schema";
import type { ChatServerOptions } from "../types";
import { authenticateRequest, resolveRequestLocale } from "../request-context";

export function registerConfigRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  app.get("/api/me", async (request) => {
    const { user } = await authenticateRequest(options, request);
    return user;
  });

  app.get("/api/branding", async (request) =>
    createClientBranding(options.config, {
      requestedLocale: resolveRequestLocale(options, request)
    })
  );

  app.get("/api/config", async (request) => {
    await authenticateRequest(options, request);
    return createSafeConfigView(options.config, {
      requestedLocale: resolveRequestLocale(options, request)
    });
  });
}
