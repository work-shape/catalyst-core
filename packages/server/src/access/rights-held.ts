import {
  asUserId,
  createAuthorizer,
  isAuthenticatedServicePrincipal,
  operationDenialError,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type OperationAuthorization,
  type PlatformStores
} from "@work-shape/catalyst-core";

/** What a write of rights runs on: the instance's stores, which it replaces by a transaction's. */
interface RightsHeldOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
}

/** The call as the write sees it under the locks: its stores, its caller and their rights now. */
export interface HeldCall<Options, Actor> {
  options: Options;
  actor: Actor;
  access: ActorAccess;
}

/**
 * Runs a write that changes who holds what, and the check that admits it, in one transaction:
 * grants and their removal, roles, legacy keys, references of tools, sign-ins, passwords,
 * memberships, service principals and keys. It takes the rights locks first, the instance's
 * and then the user's the write is about (`userId`), and every other such write takes them
 * in the same order, so none changes what the check read before this one commits and none
 * waits for another in a circle. Rights writes are rare: one at a time per instance is no cost.
 *
 * The change reads through `options.stores`, the transaction's, and asks its rules again of
 * `actor` and `access`: the caller as their record is now and their rights read anew, never the
 * snapshot the call was admitted with. The rights are also bounded by that snapshot, so a key,
 * a test run or anything else that narrowed the call narrows it still.
 */
export async function withRightsHeld<
  Options extends RightsHeldOptions,
  Actor extends AuthenticatedIdentity,
  Result
>(
  options: Options,
  call: { actor: Actor; access: ActorAccess; userId?: string },
  change: (held: HeldCall<Options, Actor>) => Promise<Result>
): Promise<Result> {
  return options.stores.transaction(async (stores) => {
    const { clientInstanceId } = options;
    await stores.access.lockRights({
      clientInstanceId,
      ...(call.userId === undefined ? {} : { userId: call.userId })
    });
    const actor = await callerNow(stores, clientInstanceId, call.actor);
    const now = await createAuthorizer(stores.access).forActor(actor);
    return change({ options: { ...options, stores }, actor, access: within(now, call.access) });
  });
}

/** A person as their record says now: the roles and references a change may have taken away. */
async function callerNow<Actor extends AuthenticatedIdentity>(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  actor: Actor
): Promise<Actor> {
  if (isAuthenticatedServicePrincipal(actor)) return actor;
  const record = await stores.users.getUser({ clientInstanceId, userId: asUserId(actor.id) });
  return record === undefined
    ? actor
    : { ...actor, roles: record.roles, permissionRefs: record.permissionRefs };
}

/** What both allow: the rights read now, never wider than the call was admitted with. */
function within(now: ActorAccess, admitted: ActorAccess): ActorAccess {
  const authorize: ActorAccess["authorize"] = (action, resource) => {
    const decision = now.authorize(action, resource);
    return decision.allowed ? admitted.authorize(action, resource) : decision;
  };
  return {
    scopeOf(dimension) {
      const current = now.scopeOf(dimension);
      const before = admitted.scopeOf(dimension);
      return current === "all"
        ? before
        : before === "all"
          ? current
          : current.filter((value) => before.includes(value));
    },
    authorize,
    authorizeTransfer(action, resource) {
      const decision = now.authorizeTransfer(action, resource);
      return decision.allowed ? admitted.authorizeTransfer(action, resource) : decision;
    },
    require(action, resource) {
      const decision = authorize(action, resource);
      if (!decision.allowed) {
        throw operationDenialError({ kind: "forbidden", action, reason: decision.reason });
      }
    },
    holdsGrantAt: (action, scopeKinds) =>
      now.holdsGrantAt(action, scopeKinds) && admitted.holdsGrantAt(action, scopeKinds),
    denials: (action) => [...now.denials(action), ...admitted.denials(action)]
  };
}

/** Throws the refusal of a check as the operation's denial. */
export function requireAuthorized(authorization: OperationAuthorization): void {
  if (!authorization.allowed) {
    throw operationDenialError({
      kind: "forbidden",
      action: authorization.action,
      reason: authorization.reason,
      ...(authorization.message === undefined ? {} : { message: authorization.message })
    });
  }
}
