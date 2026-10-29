import {
  apiOperations,
  type Operation,
  PUBLISHED_CLI_VERSION,
  RELEASE_VERSION,
  type PlatformContext
} from "@work-shape/catalyst-api-contract";
import {
  ASSET_GET_FILES_MAX_BYTES,
  ASSET_PUT_FILES_MAX_BYTES,
  FILE_SET_MAX_FILE_BYTES,
  FILE_SET_MAX_FILES,
  FILE_SET_MAX_TOTAL_BYTES,
  GRANT_SCOPE_KINDS,
  INSTANCE_ACTIONS,
  INSTANCE_ASSET_SCOPE,
  PERSONAL_API_KEY_INSPECT_ACTIONS,
  PERSONAL_API_KEY_USE_ACTIONS,
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
} from "@work-shape/catalyst-core";
import { operationScope } from "../http/operation-scope";
import type { ChatServerOptions } from "../types";
import { listedWorkflowActions, workflowOf } from "../workflows/workflow-listing";
import { accessResource, readsAssetDraft } from "../assets/asset-access";

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
 * The actions of the registered kinds a caller can use on the instance's own assets as a
 * whole: the ones its grants allow there and its credential's scopes let it call.
 */
export function usableActions(options: ContextOptions, caller: Caller): string[] {
  return actionsOn(options, caller, {});
}

/** The actions of the kinds the place lets the caller use, where its credential lets it call. */
function actionsOn(
  options: ContextOptions,
  caller: Caller,
  place: { workspaceId?: string }
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
export function readActionsOnSingleAssets(options: ContextOptions, context: Caller): string[] {
  if (!hasAuthScope(context.actor, SCOPE_OF_VERB.read)) {
    return [];
  }
  // Kinds may share their rights, as a form page shares an App's.
  return [...new Set(options.configAssets.kinds.kinds.map((kind) => kind.actions.read))].filter(
    (action) => context.access.holdsGrantAt(action, ["asset", "workspace"])
  );
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
 * Issuance choices for a personal key: the use rights of enabled kinds the caller holds
 * anywhere. These describe what a key can be given, not this credential's current rights.
 */
function heldUseActions(options: ContextOptions, caller: Caller): string[] {
  const held = heldKeyActions(options, caller, (action) =>
    PERSONAL_API_KEY_USE_ACTIONS.some((use) => use === action)
  );
  return PERSONAL_API_KEY_USE_ACTIONS.filter((action) => held.includes(action));
}

/**
 * Issuance choices, not this credential's rights: reading, writing and publishing rights held
 * anywhere, as `heldUseActions`. Deleting is left out: the key `catalyst setup` asks for
 * starts with these, and a deletion is ticked by hand.
 */
function heldAuthoringActions(options: ContextOptions, caller: Caller): string[] {
  return heldKeyActions(options, caller, (action) => /\.(read|write|publish)$/u.test(action));
}

/** The actions of kinds whose module is on that pass `pick` and the caller holds anywhere. */
function heldKeyActions(
  options: ContextOptions,
  caller: Caller,
  pick: (action: string) => boolean
): string[] {
  const offered = options.configAssets.kinds.kinds
    .filter((kind) => options.modules.offModuleOf("kind", kind.kind) === undefined)
    .flatMap((kind) => Object.values(kind.actions))
    .filter((action): action is string => action !== undefined && pick(action));
  return [...new Set(offered)].filter(
    (action) =>
      caller.access.authorize(action).allowed ||
      caller.access.holdsGrantAt(
        action,
        GRANT_SCOPE_KINDS.filter((scope) => scope !== "instance")
      )
  );
}

/**
 * The section rows of the sidebar that belong to no workspace and are there for this caller.
 * The Workflows row stands for whoever may build a Workflow, so the first one has a place to
 * go, and otherwise while either the engine lists a published Workflow or the asset list
 * shows a draft to its publisher. Both lists' own checks are asked until one passes.
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
      caller.access.holdsGrantAt(WORKFLOW_ACTIONS.write, ["asset", "workspace"]));
  // A right in a workspace reaches the Workflows it owns (WS-OWN-1b): the row is there for
  // them as for the instance's.
  const inWorkspace =
    hasAuthScope(caller.actor, SCOPE_OF_VERB.read) &&
    [WORKFLOW_ACTIONS.read, WORKFLOW_ACTIONS.use].some((action) =>
      caller.access.holdsGrantAt(action, ["workspace"])
    );
  if (writes || inWorkspace) {
    return ["workflows"];
  }
  const kind = options.configAssets.kinds.get(WORKFLOW_ASSET_KIND);
  const listed = await options.configAssets.store.listConfigAssetPage({
    clientInstanceId: options.clientInstanceId,
    kind: WORKFLOW_ASSET_KIND,
    scope: INSTANCE_ASSET_SCOPE,
    limit: 1,
    readable: (asset) =>
      (kind !== undefined &&
        hasAuthScope(caller.actor, SCOPE_OF_VERB.read) &&
        readsAssetDraft(
          kind,
          caller.access,
          accessResource(asset.kind, asset.name, asset.scope, asset.id)
        )) ||
      (asset.published === true &&
        listedWorkflowActions(
          caller.access,
          caller.actor,
          workflowOf(asset.name, { id: asset.id, scope: asset.scope })
        ).length > 0)
  });
  return listed.length > 0 ? ["workflows"] : [];
}

/**
 * The context of one caller. A workspace is listed for a caller who holds at least one action
 * of a registered kind on what it owns, and whose credential carries the scope the action is
 * called with: the answer never names an action this credential could not use.
 */
export async function readPlatformContext(
  options: ContextOptions,
  caller: Caller
): Promise<PlatformContext> {
  const { kinds } = options.configAssets.kinds;
  const [sections, workspaces] = await Promise.all([
    visibleSections(options, caller),
    usableWorkspaces(options, caller)
  ]);
  return {
    instance: {
      timeZone: options.config.clientInstance.timeZone ?? "UTC",
      timeZoneDefaulted: options.config.clientInstance.timeZone === undefined,
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
      ...(kind.kind === WORKFLOW_ASSET_KIND
        ? { source: options.config.workflows.source, repository: kind.content === "repository" }
        : {}),
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
    instanceActions: [
      ...new Set<string>([...INSTANCE_ACTIONS, ...PERSONAL_API_KEY_INSPECT_ACTIONS])
    ].filter(
      (action) =>
        caller.access.authorize(action).allowed &&
        Object.values<Operation>(apiOperations).some((operation) => {
          const scope = operationScope(caller.actor, operation);
          return (
            operation.requires?.some((required) => required === action) &&
            (operation.auth === "principal" || !isAuthenticatedServicePrincipal(caller.actor)) &&
            (scope === null || scope === undefined || hasAuthScope(caller.actor, scope))
          );
        })
    ),
    useActions: heldUseActions(options, caller),
    authoringActions: heldAuthoringActions(options, caller),
    workspaces,
    visibleSections: sections
  };
}
