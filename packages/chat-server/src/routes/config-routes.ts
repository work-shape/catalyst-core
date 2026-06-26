import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { createClientBranding, createSafeConfigView } from "@vivd-catalyst/config-schema";
import type { ChatServerOptions } from "../types";
import { authenticateRequest, resolveRequestLocale } from "../request-context";

export function registerConfigRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  app.get(apiOperations.getCurrentUser.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    return user;
  });

  app.get(apiOperations.getBranding.path, async (request) =>
    createClientBranding(options.config, {
      requestedLocale: resolveRequestLocale(options, request)
    })
  );

  app.get(apiOperations.getConfig.path, async (request) => {
    await authenticateRequest(options, request);
    const config = createSafeConfigView(options.config, {
      requestedLocale: resolveRequestLocale(options, request)
    });
    return {
      ...config,
      features: {
        ...config.features,
        attachments: {
          enabled: Boolean(options.attachments),
          accept: options.attachments?.acceptedFileTypes.join(",") ?? ""
        }
      }
    };
  });
}
