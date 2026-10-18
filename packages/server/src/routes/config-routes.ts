import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createClientBranding, createSafeConfigView } from "@work-shape/catalyst-config-schema";
import {
  allowedLegacyPermissions,
  asUserId,
  getSubjectUserId,
  moduleConfigKey,
  readDatabaseReadiness
} from "@work-shape/catalyst-core";
import { agentWriter, getWorkspaceAssetSnapshot } from "../workspaces/agent-availability";
import { agentConnections } from "../connections/agent-connections";
import type { Route } from "../http/route";
import { resolveRequestLocale } from "./request-context";
import type { ChatServerOptions } from "../types";
import { readInstanceAdminName } from "../users/instance-admin-contact";

export function registerConfigRoutes(route: Route, options: ChatServerOptions): void {
  route(apiOperations["health.get"], () => ({
    status: "ok" as const,
    clientInstanceId: options.clientInstanceId,
    time: new Date().toISOString()
  }));

  route(apiOperations["ready.get"], () => readDatabaseReadiness(options.stores));

  route(apiOperations["me.get"], async ({ user, access }) => {
    // The language is the record's, never the session's: a change elsewhere shows at once.
    const record = await options.stores.users.getUser({
      clientInstanceId: options.clientInstanceId,
      userId: asUserId(getSubjectUserId(user))
    });
    return {
      ...user,
      ...(record?.locale ? { locale: record.locale } : {}),
      permissions: allowedLegacyPermissions(access),
      instanceAdminName: await readInstanceAdminName(options.stores.users, options.clientInstanceId)
    };
  });

  route(apiOperations["branding.get"], ({ request }) =>
    createClientBranding(options.config, {
      requestedLocale: resolveRequestLocale(options, request)
    })
  );

  route(apiOperations["config.get"], async ({ request, user, access }) => {
    // The instance-wide agent list is what the caller sees in their Personal Workspace.
    const assets = await getWorkspaceAssetSnapshot(options, { kind: "personal" });
    const config = createSafeConfigView(options.config, assets, options.modules, {
      requestedLocale: resolveRequestLocale(options, request),
      reasoningEffortsOfBinding: (bindingId) =>
        options.modelGateway.capabilities({ bindingId }).reasoningEfforts,
      connections: await agentConnections(options),
      mayWriteAgent: agentWriter({ user, access }, assets)
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

  // Instance > Modules: what this instance runs. The switch itself is release config.
  route(apiOperations["instance.modules.list"], () => ({
    items: options.modules.modules.map(({ name, enabled, definition }) => ({
      name,
      enabled,
      shipped: definition !== undefined,
      configKey: moduleConfigKey(name),
      requires: [...(definition?.requires ?? [])],
      kinds: [...(definition?.kinds ?? [])],
      operationCount:
        (definition?.operations?.length ?? 0) + (definition?.selfCheckedOperations?.length ?? 0),
      jobKinds: [...(definition?.jobKinds ?? [])],
      toolCount: definition?.tools?.length ?? 0
    }))
  }));
}
