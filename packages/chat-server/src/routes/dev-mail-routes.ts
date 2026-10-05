import type { FastifyInstance } from "fastify";
import type { ChatServerOptions } from "../types";

/**
 * Development inspection route for the capture mail provider. It is not part of the product
 * API contract and is only registered when mails are captured instead of delivered, which
 * release config validation refuses in production.
 */
export function registerDevMailRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const listCaptured = options.mail?.listCaptured;
  if (!listCaptured) {
    return;
  }
  app.get("/api/dev/captured-mail", async () => listCaptured());
}
