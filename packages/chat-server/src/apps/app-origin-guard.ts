import { APP_ASSET_KIND, APP_BRIDGE_CONNECTION_CALL_REMOVED } from "@vivd-catalyst/api-contract";
import {
  AppError,
  CONNECTION_OPERATION_PREFIX,
  type ClientInstanceId,
  type ConfigAssetStore,
  type ModuleSnapshot,
  type OperationAuthorization,
  type OperationAuthorizeContext,
  type OperationDefinition,
  type OperationRegistry
} from "@vivd-catalyst/core";
import { decide } from "../asset-access";
import { appResourceOf, authorizePublishedApp, requirePublishedRevision } from "./action-source";
import { APP_ACTIONS } from "./app-kind";

// A Connection operation whose run names an App as its origin. The run is the Connection
// operation's own, so nothing of the App is in its definition. The App is asked here instead,
// for every call whose origin names one, also when a call that waited for an approval is
// executed, where nothing of the frame is left. So an App that was removed, a right on it that
// was taken away and a revision that was replaced all end such a call before the Connection
// is reached.
//
// A frame called a Connection operation directly through the kit's `connections.call` until
// it was removed. A call of it that waited for an approval across the removal is ended here
// when it is executed: it never reaches the Connection, and its run fails with the reason
// `connection_call_removed`.

/** The action name the runs of the removed `connections.call` carry in their origin. */
const REMOVED_CONNECTION_CALL_ACTION_NAME = "connections.call";

export interface AppOriginGuardDeps {
  clientInstanceId: ClientInstanceId;
  store: Pick<ConfigAssetStore, "getConfigAsset">;
  modules: Pick<ModuleSnapshot, "isEnabled" | "offModuleOf">;
}

/**
 * Whether the caller may still use the App the origin of a call names. One point read of the
 * App. A call from anywhere else, and a call of a Page of a conversation, is not asked here:
 * a Page runs reads only, which never wait, and its conversation is asked where the call is
 * made.
 */
async function authorizeAppOfOrigin(
  deps: AppOriginGuardDeps,
  effect: OperationDefinition["effect"],
  context: OperationAuthorizeContext
): Promise<OperationAuthorization> {
  const { origin } = context;
  if (origin.kind !== "app" || origin.conversationId !== undefined) {
    return { allowed: true };
  }
  const asset =
    origin.appName === undefined || deps.modules.offModuleOf("kind", APP_ASSET_KIND) !== undefined
      ? undefined
      : await deps.store.getConfigAsset({
          clientInstanceId: deps.clientInstanceId,
          kind: APP_ASSET_KIND,
          name: origin.appName
        });
  if (!asset || asset.status !== "active" || asset.scope.kind !== "workspace") {
    throw new AppError(
      "NOT_FOUND",
      "The App this call came from no longer exists, so the call was not carried out.",
      { reason: "app_gone" },
      { exposeMessage: true }
    );
  }
  if (origin.actionName === REMOVED_CONNECTION_CALL_ACTION_NAME) {
    throw new AppError(
      "CONFLICT",
      APP_BRIDGE_CONNECTION_CALL_REMOVED.message,
      { reason: APP_BRIDGE_CONNECTION_CALL_REMOVED.code },
      { exposeMessage: true }
    );
  }
  const resource = appResourceOf({
    id: asset.id,
    name: asset.name,
    workspaceId: asset.scope.workspaceId
  });
  if (origin.appRevisionId === asset.publishedRevisionId) {
    return authorizePublishedApp(context, resource);
  }
  // Any other revision is a draft, which only who writes the App is shown and which runs
  // reads only. A changing call of another revision was made while that one was published.
  if (effect === "changing") {
    requirePublishedRevision(origin, asset.publishedRevisionId);
  }
  return decide(context.access, APP_ACTIONS.write, resource);
}

/**
 * The registry with the App of a call's origin asked before every Connection operation's own
 * rule. Every other operation is as the registry has it.
 */
export function guardAppOrigin(
  registry: OperationRegistry,
  deps: AppOriginGuardDeps
): OperationRegistry {
  const guarded = (definition: OperationDefinition): OperationDefinition =>
    // A Connection operation decides its right itself, so its own rule is what is wrapped.
    definition.action === null && definition.name.startsWith(CONNECTION_OPERATION_PREFIX)
      ? {
          ...definition,
          async authorize(input, context) {
            const own = await authorizeAppOfOrigin(deps, definition.effect, context);
            return own.allowed ? definition.authorize(input, context) : own;
          }
        }
      : definition;
  return {
    ...registry,
    async resolve(name) {
      const definition = await registry.resolve(name);
      return definition && guarded(definition);
    },
    async resolveMany(names) {
      const found = await registry.resolveMany(names);
      return new Map([...found].map(([name, definition]) => [name, guarded(definition)]));
    },
    async list(scope) {
      const listing = await registry.list(scope);
      return { ...listing, operations: listing.operations.map(guarded) };
    }
  };
}
