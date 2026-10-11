import { RELEASE_VERSION, apiOperations } from "@vivd-catalyst/api-contract";
import {
  AppError,
  hasAuthScope,
  type ActorAccess,
  type AssetKindActions,
  type AuthenticatedIdentity,
  type OperationScope
} from "@vivd-catalyst/core";
import { configAssetReferences } from "../config-asset-workflow";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/** The rights of a kind that decide what a caller does with its definitions. */
const VERBS = ["read", "write", "delete"] as const satisfies readonly (keyof AssetKindActions)[];

/** The scope a credential must carry before its holder can use each of those rights. */
const SCOPE_OF_VERB = {
  read: "config_assets:read",
  write: "config_assets:write",
  delete: "config_assets:write"
} as const satisfies Record<(typeof VERBS)[number], OperationScope>;

/**
 * The actions of the registered kinds a caller can use: the ones its grants allow on what
 * `name` says and its credential's scopes let it call. With a Namespace prefix that is the
 * Namespace, without a name the instance's own assets as a whole.
 */
function usableActions(
  options: ChatServerOptions,
  caller: { access: ActorAccess; actor: AuthenticatedIdentity },
  name?: string
): string[] {
  const usable = VERBS.filter((verb) => hasAuthScope(caller.actor, SCOPE_OF_VERB[verb]));
  return options.configAssets.kinds.kinds.flatMap((kind) =>
    usable
      .map((verb) => kind.actions[verb])
      .filter(
        (action) =>
          caller.access.authorize(action, {
            kind: kind.kind,
            ...(name === undefined ? {} : { name })
          }).allowed
      )
  );
}

/**
 * The read actions of the registered kinds a grant row allows the caller on one asset or on one
 * workspace's assets, where its credential's scopes let it read. Read from the grant rows the
 * request's authorization already loaded: it sends no statement.
 */
function readActionsOnSingleAssets(
  options: ChatServerOptions,
  context: { access: ActorAccess; actor: AuthenticatedIdentity }
): string[] {
  if (!hasAuthScope(context.actor, SCOPE_OF_VERB.read)) {
    return [];
  }
  return options.configAssets.kinds.kinds
    .map((kind) => kind.actions.read)
    .filter((action) => context.access.holdsGrantAt(action, ["asset", "workspace"]));
}

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
        actions: usableActions(options, { access, actor }),
        assetActions: readActionsOnSingleAssets(options, { access, actor }),
        namespaces: namespaces.flatMap((namespace) => {
          const actions = usableActions(options, { access, actor }, namespace.prefix);
          return actions.length > 0
            ? [{ prefix: namespace.prefix, displayName: namespace.displayName, actions }]
            : [];
        })
      };
    }
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
