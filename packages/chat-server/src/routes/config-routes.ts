import { apiOperations } from "@vivd-catalyst/api-contract";
import { createClientBranding, createSafeConfigView } from "@vivd-catalyst/config-schema";
import { allowedLegacyPermissions, readDatabaseReadiness } from "@vivd-catalyst/core";
import { getWorkspaceAssetSnapshot } from "../agent-availability";
import type { Route } from "../http/route";
import { resolveRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConfigRoutes(route: Route, options: ChatServerOptions): void {
  route(apiOperations["health.get"], () => ({
    status: "ok" as const,
    clientInstanceId: options.clientInstanceId,
    time: new Date().toISOString()
  }));

  route(apiOperations["ready.get"], () => readDatabaseReadiness(options.stores));

  route(apiOperations["me.get"], ({ user, access }) => ({
    ...user,
    permissions: allowedLegacyPermissions(access)
  }));

  route(apiOperations["branding.get"], ({ request }) =>
    createClientBranding(options.config, {
      requestedLocale: resolveRequestLocale(options, request)
    })
  );

  route(apiOperations["config.get"], async ({ request }) => {
    // The instance-wide agent list is what the caller sees in their Personal Workspace.
    const assets = await getWorkspaceAssetSnapshot(options, { kind: "personal" });
    const config = createSafeConfigView(options.config, assets, {
      requestedLocale: resolveRequestLocale(options, request),
      reasoningEffortsOfBinding: (bindingId) =>
        options.modelGateway.capabilities({ bindingId }).reasoningEfforts
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
