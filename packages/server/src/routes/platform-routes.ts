import { apiOperations } from "@work-shape/catalyst-api-contract";
import { AppError } from "@work-shape/catalyst-core";
import { readPlatformDocs } from "../platform/platform-docs";
import { configAssetReferences } from "../config-assets/config-asset-service";
import { readCapabilities } from "../platform/platform-capabilities";
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

  route.operation(apiOperations["platform.docs.get"], {
    authorize: () => ({ allowed: true }),
    execute: (input) => readPlatformDocs(options, input.page)
  });

  // What an editor offers for a definition: the models, efforts and tools of this instance.
  // Readers of one asset or workspace need the same labels as instance-wide readers. These
  // references come only from release config; reading an asset still checks its own right.
  route(apiOperations["platform.references.get"], async ({ access, identity }) => {
    requireReferenceReader({ access, actor: identity }, "the references");
    return configAssetReferences(options);
  });

  // Studio's "Fähigkeiten" page: who may read the references reads what they offer by package,
  // with the agents that use each among those the caller may read.
  route(apiOperations["platform.capabilities.get"], async ({ access, identity }) => {
    requireReferenceReader({ access, actor: identity }, "what agents can be given");
    return readCapabilities(options, access);
  });

  function requireReferenceReader(caller: Parameters<typeof usableActions>[1], what: string) {
    if (
      usableActions(options, caller).length === 0 &&
      readActionsOnSingleAssets(options, caller).length === 0
    ) {
      throw new AppError(
        "FORBIDDEN",
        `Reading ${what} needs a right on an asset kind, on the instance, in a workspace or on one asset`
      );
    }
  }
}
