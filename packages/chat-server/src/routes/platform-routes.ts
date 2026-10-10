import { RELEASE_VERSION, apiOperations } from "@vivd-catalyst/api-contract";
import { hasAuthScope, type AssetKindActions, type OperationScope } from "@vivd-catalyst/core";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/** The scope a credential must carry before its holder can use each right of a kind. */
const SCOPE_OF_VERB = {
  read: "config_assets:read",
  write: "config_assets:write",
  delete: "config_assets:write"
} as const satisfies Record<keyof AssetKindActions, OperationScope>;

const VERBS = ["read", "write", "delete"] as const;

export function registerPlatformRoutes(route: Route, options: ChatServerOptions): void {
  // Orientation for an outside editor, a person or a service principal. A Namespace is listed
  // for a caller who holds at least one action of a registered kind in it, through any grant
  // that covers its names, and whose credential carries the scope the action is called with:
  // the answer never names an action this credential could not use.
  route.operation(apiOperations["platform.context.get"], {
    // Every authenticated caller may ask where it is. What it is told is its own.
    authorize: () => ({ allowed: true }),
    async execute(_input, { access, actor }) {
      const { kinds } = options.configAssets.kinds;
      // The Namespaces alone: no count is shown here, so none is computed.
      const namespaces = await options.stores.access.listNamespaceRecords({
        clientInstanceId: options.clientInstanceId
      });
      const usable = VERBS.filter((verb) => hasAuthScope(actor, SCOPE_OF_VERB[verb]));
      return {
        instance: {
          id: options.clientInstanceId,
          name: options.config.clientInstance.displayName
        },
        release: { version: RELEASE_VERSION },
        kinds: kinds.map((kind) => ({
          kind: kind.kind,
          plural: kind.plural,
          actions: { ...kind.actions }
        })),
        namespaces: namespaces.flatMap((namespace) => {
          const actions = kinds.flatMap((kind) =>
            usable
              .map((verb) => kind.actions[verb])
              .filter(
                (action) =>
                  access.authorize(action, { kind: kind.kind, name: namespace.prefix }).allowed
              )
          );
          return actions.length > 0
            ? [{ prefix: namespace.prefix, displayName: namespace.displayName, actions }]
            : [];
        })
      };
    }
  });
}
