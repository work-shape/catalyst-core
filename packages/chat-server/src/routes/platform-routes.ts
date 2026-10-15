import { apiOperations } from "@work-shape/catalyst-api-contract";
import { AppError } from "@work-shape/catalyst-core";
import { configAssetReferences } from "../config-asset-workflow";
import type { Route } from "../http/route";
import { readPlatformContext, usableActions } from "../platform-context";
import type { ChatServerOptions } from "../types";

export function registerPlatformRoutes(route: Route, options: ChatServerOptions): void {
  // Orientation for an outside editor, a person, a service principal or an agent's tool.
  route.operation(apiOperations["platform.context.get"], {
    // Every authenticated caller may ask where it is. What it is told is its own.
    authorize: () => ({ allowed: true }),
    execute: (_input, { access, actor }) => readPlatformContext(options, { access, actor })
  });

  // What an editor offers for a definition: the models, efforts and tools of this instance.
  // It is for whoever can use an action of a registered kind somewhere, on the instance as a
  // whole or in one Namespace, decided as the context decides which Namespaces it lists. The
  // answer comes from the release config, so the store is read for the Namespaces only, and
  // only for a caller who holds nothing on the instance as a whole.
  route(apiOperations["platform.references.get"], async ({ access, identity }) => {
    const caller = { access, actor: identity };
    if (usableActions(options, caller).length === 0) {
      const namespaces = await options.stores.access.listNamespaceRecords({
        clientInstanceId: options.clientInstanceId
      });
      if (!namespaces.some(({ prefix }) => usableActions(options, caller, prefix).length > 0)) {
        throw new AppError(
          "FORBIDDEN",
          "Reading the references needs a right on an asset kind, on the instance or in a Namespace"
        );
      }
    }
    return configAssetReferences(options);
  });
}
