import {
  accessHolderFromIdentity,
  createActorAccess,
  type ActorAccess,
  type AuthenticatedIdentity,
  type PersistedAccess
} from "@vivd-catalyst/core";

/**
 * The answers the route helper would load for a caller, for a test that calls a workflow
 * directly: the caller's own record, plus the persisted state the test names.
 */
export function accessOf(
  actor: AuthenticatedIdentity,
  persisted: Partial<PersistedAccess> = {}
): ActorAccess {
  return createActorAccess(accessHolderFromIdentity(actor), {
    holderActive: true,
    grants: [],
    ...persisted
  });
}

/** A caller built in place, as the two leading arguments of a workflow call. */
export function callerOf<Actor extends AuthenticatedIdentity>(actor: Actor): [Actor, ActorAccess] {
  return [actor, accessOf(actor)];
}
