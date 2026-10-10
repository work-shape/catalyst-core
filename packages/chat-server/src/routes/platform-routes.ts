import { RELEASE_VERSION, apiOperations } from "@vivd-catalyst/api-contract";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

export function registerPlatformRoutes(route: Route, options: ChatServerOptions): void {
  // Orientation for an outside editor. A Namespace is listed for a caller who holds at least
  // one action of a registered kind in it, through any grant that covers its names.
  route(apiOperations["platform.context.get"], async ({ access }) => {
    const { kinds } = options.configAssets.kinds;
    const namespaces = await options.stores.access.listNamespaces({
      clientInstanceId: options.clientInstanceId
    });
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
          [kind.actions.read, kind.actions.write, kind.actions.delete].filter(
            (action) =>
              access.authorize(action, { kind: kind.kind, name: namespace.prefix }).allowed
          )
        );
        return actions.length > 0
          ? [{ prefix: namespace.prefix, displayName: namespace.displayName, actions }]
          : [];
      })
    };
  });
}
