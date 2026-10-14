import {
  PUBLISHED_CLI_VERSION,
  RELEASE_VERSION,
  type PlatformContext
} from "@vivd-catalyst/api-contract";
import {
  ASSET_GET_FILES_MAX_BYTES,
  ASSET_PUT_FILES_MAX_BYTES,
  FILE_SET_MAX_FILE_BYTES,
  FILE_SET_MAX_FILES,
  FILE_SET_MAX_TOTAL_BYTES,
  INSTANCE_ASSET_SCOPE,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  asUserId,
  hasAuthScope,
  isAuthenticatedServicePrincipal,
  isPrincipalGrantableAction,
  type ActorAccess,
  type AssetKindActions,
  type AuthenticatedIdentity,
  type OperationScope
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";
import { listedWorkflowActions, workflowOf } from "./workflow-listing";

// Where a caller is: the instance, its release, the asset kinds and what the caller may do with
// them. `platform.context.get` answers it, and so does the agent's tool that projects it.

type ContextOptions = Pick<
  ChatServerOptions,
  "clientInstanceId" | "config" | "configAssets" | "modules" | "stores"
>;

interface Caller {
  access: ActorAccess;
  actor: AuthenticatedIdentity;
}

/**
 * The scope a credential must carry before its holder can use each right of a kind. `use` is
 * not among them: it is held on what one workspace owns and never on the instance as a whole.
 */
const SCOPE_OF_VERB = {
  read: "config_assets:read",
  write: "config_assets:write",
  delete: "config_assets:write",
  publish: "config_assets:publish"
} as const satisfies Partial<Record<keyof AssetKindActions, OperationScope>>;

const VERBS = ["read", "write", "delete", "publish"] as const;

/**
 * The actions of the registered kinds a caller can use: the ones its grants allow on what
 * `name` says and its credential's scopes let it call. With a Namespace prefix that is the
 * Namespace, without a name the instance's own assets as a whole.
 */
export function usableActions(options: ContextOptions, caller: Caller, name?: string): string[] {
  return actionsOn(options, caller, name === undefined ? {} : { name });
}

/** The actions of the kinds the place lets the caller use, where its credential lets it call. */
function actionsOn(
  options: ContextOptions,
  caller: Caller,
  place: { name?: string; workspaceId?: string }
): string[] {
  const usable = VERBS.filter((verb) => hasAuthScope(caller.actor, SCOPE_OF_VERB[verb]));
  return options.configAssets.kinds.kinds
    .filter((kind) => place.workspaceId === undefined || kind.owners.includes("workspace"))
    .flatMap((kind) =>
      usable
        .flatMap((verb) => kind.actions[verb] ?? [])
        .filter((action) => caller.access.authorize(action, { kind: kind.kind, ...place }).allowed)
    );
}

/**
 * The workspaces whose own assets the caller can use an action on: every Shared Workspace and
 * the caller's own workspaces are asked, and the ones with none are left out. A workspace is
 * named to nobody who holds nothing there.
 */
async function usableWorkspaces(
  options: ContextOptions,
  caller: Caller
): Promise<PlatformContext["workspaces"]> {
  const { clientInstanceId } = options;
  const [shared, own] = await Promise.all([
    options.stores.workspaces.listSharedWorkspaces({ clientInstanceId }),
    isAuthenticatedServicePrincipal(caller.actor)
      ? []
      : options.stores.workspaces.listWorkspacesForUser({
          clientInstanceId,
          userId: asUserId(caller.actor.id)
        })
  ]);
  const workspaces = new Map([...shared, ...own].map((workspace) => [workspace.id, workspace]));
  const memberOf = new Set(own.map((workspace) => workspace.id));
  return [...workspaces.values()].flatMap((workspace) => {
    const actions = actionsOn(options, caller, { workspaceId: workspace.id });
    const { id, name, kind } = workspace;
    return actions.length > 0 ? [{ id, name, kind, member: memberOf.has(id), actions }] : [];
  });
}

/**
 * The read actions of the registered kinds a grant row allows the caller on one asset or on one
 * workspace's assets, where its credential's scopes let it read. Read from the grant rows the
 * request's authorization already loaded: it sends no statement.
 */
function readActionsOnSingleAssets(options: ContextOptions, context: Caller): string[] {
  if (!hasAuthScope(context.actor, SCOPE_OF_VERB.read)) {
    return [];
  }
  return options.configAssets.kinds.kinds
    .map((kind) => kind.actions.read)
    .filter((action) => context.access.holdsGrantAt(action, ["asset", "workspace"]));
}

/**
 * The rights of a kind a service principal can be granted: the ones of the one list in `core`
 * that the kind registers, which is what the grant write hands out. A kind of a module that is
 * off has none to hand out.
 */
function principalActionsOf(
  options: ContextOptions,
  kind: { kind: string; actions: AssetKindActions }
): { principalActions?: string[] } {
  if (options.modules.offModuleOf("kind", kind.kind) !== undefined) {
    return {};
  }
  const principalActions = Object.values(kind.actions).filter(
    (action): action is string => action !== undefined && isPrincipalGrantableAction(action)
  );
  return principalActions.length > 0 ? { principalActions } : {};
}

/**
 * The section rows of the sidebar that belong to no workspace and are there for this caller.
 * The Workflows row stands for whoever may build a Workflow, so the first one has a place to
 * go, and otherwise only while `workflows.list` names one to this caller: the list's own
 * check is asked of each published Workflow until one passes.
 */
async function visibleSections(
  options: ContextOptions,
  caller: Caller
): Promise<PlatformContext["visibleSections"]> {
  if (!options.modules.isEnabled("workflows")) {
    return [];
  }
  const writes =
    hasAuthScope(caller.actor, SCOPE_OF_VERB.write) &&
    (caller.access.authorize(WORKFLOW_ACTIONS.write, { kind: WORKFLOW_ASSET_KIND }).allowed ||
      caller.access.holdsGrantAt(WORKFLOW_ACTIONS.write, ["namespace", "asset"]));
  if (writes) {
    return ["workflows"];
  }
  const listed = await options.configAssets.store.listConfigAssetPage({
    clientInstanceId: options.clientInstanceId,
    kind: WORKFLOW_ASSET_KIND,
    scope: INSTANCE_ASSET_SCOPE,
    limit: 1,
    readable: (asset) =>
      asset.published === true &&
      listedWorkflowActions(caller.access, caller.actor, workflowOf(asset.name, asset.id)).length >
        0
  });
  return listed.length > 0 ? ["workflows"] : [];
}

/**
 * The context of one caller. A Namespace is listed for a caller who holds at least one action
 * of a registered kind in it, through any grant that covers its names, and whose credential
 * carries the scope the action is called with: the answer never names an action this
 * credential could not use.
 */
export async function readPlatformContext(
  options: ContextOptions,
  caller: Caller
): Promise<PlatformContext> {
  const { kinds } = options.configAssets.kinds;
  // The Namespaces alone: no count is shown here, so none is computed.
  const [namespaces, sections, workspaces] = await Promise.all([
    options.stores.access.listNamespaceRecords({ clientInstanceId: options.clientInstanceId }),
    visibleSections(options, caller),
    usableWorkspaces(options, caller)
  ]);
  return {
    instance: {
      id: options.clientInstanceId,
      name: options.config.clientInstance.displayName
    },
    release: {
      version: RELEASE_VERSION,
      ...(PUBLISHED_CLI_VERSION === undefined ? {} : { cliVersion: PUBLISHED_CLI_VERSION })
    },
    kinds: kinds.map((kind) => ({
      kind: kind.kind,
      plural: kind.plural,
      lifecycle: kind.lifecycle,
      representation: kind.representation,
      owners: [...kind.owners],
      actions: { ...kind.actions },
      ...principalActionsOf(options, kind),
      ...(kind.representation === "files"
        ? {
            ...(kind.manifestFile === undefined ? {} : { manifestFile: kind.manifestFile }),
            limits: {
              FILE_SET_MAX_FILES,
              FILE_SET_MAX_FILE_BYTES,
              FILE_SET_MAX_TOTAL_BYTES,
              ASSET_PUT_FILES_MAX_BYTES,
              ASSET_GET_FILES_MAX_BYTES
            }
          }
        : {})
    })),
    actions: usableActions(options, caller),
    assetActions: readActionsOnSingleAssets(options, caller),
    namespaces: namespaces.flatMap((namespace) => {
      const actions = usableActions(options, caller, namespace.prefix);
      return actions.length > 0
        ? [{ prefix: namespace.prefix, displayName: namespace.displayName, actions }]
        : [];
    }),
    workspaces,
    visibleSections: sections
  };
}
