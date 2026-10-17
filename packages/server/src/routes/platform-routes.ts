import { apiOperations } from "@work-shape/catalyst-api-contract";
import { AppError } from "@work-shape/catalyst-core";
import { configAssetReferences } from "../config-assets/config-asset-service";
import type { Route } from "../http/route";
import {
  readActionsOnSingleAssets,
  readPlatformContext,
  usableActions
} from "../platform/platform-context";
import type { ChatServerOptions } from "../types";

export function registerPlatformRoutes(route: Route, options: ChatServerOptions): void {
  // Orientation for an outside editor, a person, a service principal or an agent's tool.
  route.operation(apiOperations["platform.context.get"], {
    // Every authenticated caller may ask where it is. What it is told is its own.
    authorize: () => ({ allowed: true }),
    execute: (_input, { access, actor }) => readPlatformContext(options, { access, actor })
  });

  // What an editor offers for a definition: the models, efforts and tools of this instance.
  // Readers of one asset or workspace need the same labels as instance-wide readers. These
  // references come only from release config; reading an asset still checks its own right.
  route(apiOperations["platform.references.get"], async ({ access, identity }) => {
    const caller = { access, actor: identity };
    if (
      usableActions(options, caller).length === 0 &&
      readActionsOnSingleAssets(options, caller).length === 0
    ) {
      const namespaces = await options.stores.access.listNamespaceRecords({
        clientInstanceId: options.clientInstanceId
      });
      if (!namespaces.some(({ prefix }) => usableActions(options, caller, prefix).length > 0)) {
        throw new AppError(
          "FORBIDDEN",
          "Reading the references needs a right on an asset kind, on the instance, in a workspace or on one asset"
        );
      }
    }
    return configAssetReferences(options);
  });
}
