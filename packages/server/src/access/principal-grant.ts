import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  MAIL_SENDER_RESOURCE_KIND,
  MAIL_SENDER_USE_ACTION,
  asCollaborationWorkspaceId,
  isPlatformAction,
  isPrincipalGrantableAction,
  moduleOffError,
  type AccessResource,
  type GrantScopeAsset,
  type PermissionGrant,
  type ServicePrincipalRecord,
  type ActorAccess,
  type AuthenticatedUser
} from "@work-shape/catalyst-core";
import { accessResource } from "../assets/asset-access";
import type { ChatServerOptions } from "../types";
import { authorizePrincipalHolderWrite } from "./grant-holder-rules";
import { assetRight, authorizeGivingToPrincipal } from "./principal-rights";
import { requireAuthorized } from "./rights-held";

// The rules of a service principal's grant row, asked by the grant write and, without
// writing, by the publish screen of a Workflow that asks what its caller could give.

export type PrincipalGrantOptions = Pick<
  ChatServerOptions,
  "clientInstanceId" | "stores" | "modules" | "configAssets" | "mailSenders"
>;

/** What one grant row names. */
export interface PrincipalGrantCommand {
  holderId: string;
  action: string;
  scopeKind: PermissionGrant["scopeKind"];
  scopeId?: string;
  effect: PermissionGrant["effect"];
}

/** Reads the asset a grant names, refusing one that is no active asset of the right's kind. */
type GrantAssetOf = (command: PrincipalGrantCommand) => Promise<Omit<GrantScopeAsset, "active">>;

/**
 * The limits of a service principal's row, each refused by name. Who: whoever administers
 * service principals. What: a use right of the one list in `core` that a kind of this
 * instance registers; a right of the list whose kind this instance has not loaded is refused
 * like one outside the list, so no row waits for a kind to arrive. Effect: allow. Where: one
 * named asset of the right's kind, so nothing created later is reachable by a principal that
 * was not given it. The writer may read that asset (`not_visible`): no one gives a right on a
 * resource they may not see. And the writer holds the right there: the rule of no escalation,
 * asked last, of the asset as it is now. Answers the principal and the asset the row names.
 */
export async function checkPrincipalGrant(
  options: PrincipalGrantOptions,
  caller: { actor: AuthenticatedUser; access: ActorAccess },
  operation: string,
  command: PrincipalGrantCommand,
  assetOf: GrantAssetOf = (named) => grantableAsset(options, named)
): Promise<{ principal: ServicePrincipalRecord; asset: Omit<GrantScopeAsset, "active"> }> {
  requireAuthorized(authorizePrincipalHolderWrite(caller.actor, caller.access, operation));
  const principal = await findAdministrablePrincipal(options, command.holderId);
  if (!principal) {
    throw new AppError("NOT_FOUND", "Service principal not found", {
      reason: "unknown_holder"
    });
  }
  const { action } = command;
  if (!isPrincipalGrantableAction(action)) {
    throw refused(
      "action_not_grantable_to_principal",
      `'${action}' cannot be granted to a service principal: a service principal is granted the use rights of a resource and nothing else`
    );
  }
  const module = options.modules.offModuleOf("kind", kindOfAction(action));
  if (module !== undefined) {
    throw moduleOffError(module);
  }
  const kind = options.configAssets.kinds.get(kindOfAction(action));
  if (
    !mailSenderRegistered(options, action) &&
    (!kind || !Object.values(kind.actions).some((right) => right === action))
  ) {
    throw refused(
      "action_not_grantable_to_principal",
      `'${action}' cannot be granted on this instance: no asset kind it has loaded registers the right`
    );
  }
  if (command.effect !== "allow") {
    throw refused(
      "effect_not_grantable_to_principal",
      "A service principal is allowed a right and never denied one: revoke the grant instead"
    );
  }
  if (command.scopeKind !== "asset") {
    throw refused(
      "invalid_scope",
      "A service principal is granted a right on one named asset only"
    );
  }
  const asset = await assetOf(command);
  if (!maySeeAsset(caller.access, grantAssetResource(asset))) {
    throw new AppError(
      "FORBIDDEN",
      "You may not read this resource, so you cannot give a right on it",
      {
        reason: "not_visible",
        action: `${asset.kind}.read`
      }
    );
  }
  requireAuthorized(
    await authorizeGivingToPrincipal(
      { clientInstanceId: options.clientInstanceId, access: options.stores.access },
      caller,
      principal,
      [assetRight(action, asset)]
    )
  );
  return { principal, asset };
}

/**
 * Whether the caller may read the asset: every kind's read right is `<kind>.read`. The grant
 * write asks it, and so does what the publish screen of a Workflow shows of an asset. A mail
 * sender has no read right: it is seen by whoever may send as it.
 */
export function maySeeAsset(
  access: Pick<ActorAccess, "authorize">,
  resource: AccessResource
): boolean {
  if (resource.kind === MAIL_SENDER_RESOURCE_KIND)
    return access.authorize(MAIL_SENDER_USE_ACTION, resource).allowed;
  const read = `${resource.kind ?? ""}.read`;
  return isPlatformAction(read) && access.authorize(read, resource).allowed;
}

/**
 * Whether the action is `mail_sender.use` and this instance registers a sender (MAIL-1). The
 * kind is no asset kind: its one resource is a named sender, `system`, which exists only while
 * release config switches outbound mail on.
 */
function mailSenderRegistered(
  options: Pick<PrincipalGrantOptions, "mailSenders">,
  action: string
): boolean {
  return action === MAIL_SENDER_USE_ACTION && (options.mailSenders?.length ?? 0) > 0;
}

/**
 * What a right on the asset a grant names is decided on, built as the asset's own reads build
 * it (`accessResource`): its kind, name, id and the workspace that owns it, so a deny in that
 * workspace counts here as it counts there.
 */
export function grantAssetResource(asset: Omit<GrantScopeAsset, "active">): AccessResource {
  return accessResource(
    asset.kind,
    asset.name,
    asset.workspaceId === undefined
      ? INSTANCE_ASSET_SCOPE
      : { kind: "workspace", workspaceId: asCollaborationWorkspaceId(asset.workspaceId) },
    asset.id
  );
}

/**
 * The active asset of the action's kind an asset grant names. A grant of `mail_sender.use`
 * names one registered sender by its id, `system`: the sender stands in for the asset, and
 * no other resource takes the right.
 */
export async function grantableAsset(
  options: Pick<PrincipalGrantOptions, "clientInstanceId" | "stores" | "mailSenders">,
  command: Pick<PrincipalGrantCommand, "action" | "scopeId">
): Promise<Omit<GrantScopeAsset, "active">> {
  if (command.scopeId === undefined) {
    throw refused("invalid_scope", "An asset grant names an asset id");
  }
  if (kindOfAction(command.action) === MAIL_SENDER_RESOURCE_KIND) {
    if (!options.mailSenders?.includes(command.scopeId)) {
      throw refused(
        "invalid_scope",
        "A grant of mail_sender.use names a sender this instance registers: system"
      );
    }
    return mailSenderGrantAsset(command.scopeId);
  }
  const asset = await options.stores.access.getGrantableAsset({
    clientInstanceId: options.clientInstanceId,
    assetId: command.scopeId
  });
  // The action carries the kind, so a skill action on an agent could never match.
  if (!asset || asset.kind !== kindOfAction(command.action)) {
    throw refused("invalid_scope", "The asset is not an active asset of the action's kind");
  }
  return asset;
}

/** A sender as the grant rules and the evaluator read it: its id stands for kind, name and id. */
function mailSenderGrantAsset(sender: string): Omit<GrantScopeAsset, "active"> {
  return { id: sender, kind: MAIL_SENDER_RESOURCE_KIND, name: sender };
}

/** A service principal an administrator manages: one no owner keeps for itself. */
export async function findAdministrablePrincipal(
  options: Pick<PrincipalGrantOptions, "clientInstanceId" | "stores">,
  servicePrincipalId: string
): Promise<ServicePrincipalRecord | undefined> {
  const principals = await options.stores.apiAccess.listServicePrincipals({
    clientInstanceId: options.clientInstanceId
  });
  return principals.find((candidate) => candidate.id === servicePrincipalId && !candidate.owner);
}

/** The asset kind an action is a right of: `agent` of `agent.read`. */
export function kindOfAction(action: string): string {
  return action.slice(0, action.indexOf("."));
}

export function refused(reason: string, message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason });
}
