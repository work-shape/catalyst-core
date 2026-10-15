import {
  LEGACY_LIST_GRANTOR,
  accessHolderFromIdentity,
  asUserId,
  createActorAccess,
  legacyGrantRows,
  type ActorAccess,
  type AuthenticatedIdentity,
  type PermissionGrant,
  type PersistedAccess
} from "@work-shape/catalyst-core";

/**
 * The answers the route helper would load for a caller, for a test that calls a workflow
 * directly: the caller's own record, plus the persisted state the test names. The legacy list
 * the actor carries is its instance-wide rows, as the store holds them since AP-4.
 */
export function accessOf(
  actor: AuthenticatedIdentity,
  persisted: Partial<PersistedAccess> = {}
): ActorAccess {
  const holder = accessHolderFromIdentity(actor);
  const listRows = legacyGrantRows(actor.permissions ?? []).map((row, index): PermissionGrant => ({
    id: `grant_list_${index}`,
    clientInstanceId: holder.clientInstanceId,
    holderKind: holder.kind,
    holderId: holder.id,
    action: row.action,
    effect: row.effect,
    scopeKind: "instance",
    grantedBy: asUserId(LEGACY_LIST_GRANTOR),
    createdAt: "2026-01-01T00:00:00.000Z"
  }));
  return createActorAccess(holder, {
    holderActive: true,
    ...persisted,
    grants: [...listRows, ...(persisted.grants ?? [])]
  });
}

/** A caller built in place, as the two leading arguments of a workflow call. */
export function callerOf<Actor extends AuthenticatedIdentity>(actor: Actor): [Actor, ActorAccess] {
  return [actor, accessOf(actor)];
}
