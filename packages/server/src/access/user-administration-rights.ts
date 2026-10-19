import {
  PERMISSION_REF_ACTION_PREFIX,
  asUserId,
  isAuthenticatedServicePrincipal,
  isPermission,
  isSuperadmin,
  isSuperadminGrantedAction,
  type ActorAccess,
  type AuthenticatedIdentity,
  type HeldRight,
  type OperationAuthorization,
  type UserRecord,
  type UserRole
} from "@work-shape/catalyst-core";
import { authorizeHeldRightsWithin } from "./held-rights-within";
import { personRights } from "./person-rights";
import { requireAuthorized } from "./rights-held";
import { RELEASE_KEY } from "./principal-rights";
import {
  carriesSuperadminGrantedAction,
  currentRoleGrants,
  rightsOfGrants,
  type RoleRightsOptions
} from "./role-rights";
import type { ChatServerOptions } from "../types";

/** The right every user administration operation asks for, on the instance. */
const USERS_MANAGE_ACTION = "users.manage";

/** What a call changes about a user's roles and directly held rights, as far as it names them. */
interface UserRightsChange {
  roles?: readonly UserRole[];
  /** The references of tools the user may use, each checked as the action `ref:<reference>`. */
  permissionRefs?: readonly string[];
  permissions?: readonly string[];
}

/** The call as the rules read it: whom it changes, and what of their rights. */
interface UserAdministrationCall extends UserRightsChange {
  /** The user the call changes. A call that creates one names none. */
  userId?: string;
  /** The name of the user a call creates, as a refusal names them. */
  displayLabel?: string;
  /** Only a superadmin makes this call at all: deleting a user. */
  superadminOnly?: true;
}

/** Who makes the call, with the rights of the call itself. */
interface Caller {
  actor: AuthenticatedIdentity;
  access: ActorAccess;
}

type RulesOptions = Pick<ChatServerOptions, "stores" | "clientInstanceId">;

/** The entries a submitted list of rights adds to or removes from the list a user has. */
export function changedPermissionEntries(
  permissions: readonly string[] | undefined,
  existing: readonly string[] = []
): string[] {
  if (permissions === undefined) return [];
  const previous = new Set(existing);
  const submitted = new Set(permissions);
  return [
    ...permissions.filter((permission) => !previous.has(permission)),
    ...existing.filter((permission) => !submitted.has(permission))
  ];
}

/**
 * Who may call a user administration operation. It is the `authorize` of the seven changing
 * operations, so the run records the check and a refusal, and nothing of the operation runs
 * for anybody else. `users.manage` is asked first, so a caller without it causes no read, and
 * so is the deletion only a superadmin makes. A refusal by a superadmin rule names the
 * operation and says the rule, since no right a caller can be granted opens it. A user that
 * does not exist passes: the operation answers that itself.
 */
export async function authorizeUserAdministration(
  options: RulesOptions,
  operationId: string,
  caller: Caller,
  call: UserAdministrationCall
): Promise<OperationAuthorization> {
  const right = caller.access.authorize(USERS_MANAGE_ACTION);
  if (!right.allowed) {
    return { allowed: false, action: USERS_MANAGE_ACTION, reason: right.reason };
  }
  // A service principal administers no user, whatever it was granted.
  if (isAuthenticatedServicePrincipal(caller.actor)) {
    return {
      allowed: false,
      action: operationId,
      reason: "no_grant",
      message: "Only a signed-in user may administer users"
    };
  }
  if (call.superadminOnly && !isSuperadminActor(caller.actor)) {
    return superadminRuleRefusal(operationId, "Only a superadmin may delete a user");
  }
  const target =
    call.userId === undefined
      ? undefined
      : await options.stores.users.getUser({
          clientInstanceId: options.clientInstanceId,
          userId: asUserId(call.userId)
        });
  if (call.userId !== undefined && target === undefined) return { allowed: true };
  return userAdministrationRule(options, operationId, caller, target, call);
}

/**
 * The whole check of `authorizeUserAdministration`, asked again where the operation writes:
 * under the rights locks, of the stores of its transaction and of the caller's rights now
 * (`withRightsHeld`). A user may have become a superadmin, been given a right, or the caller
 * lost one, since the call was admitted. The refusal ends the run as denied.
 */
export async function requireUserAdministration(
  options: RulesOptions,
  operationId: string,
  caller: Caller,
  call: UserAdministrationCall
): Promise<void> {
  requireAuthorized(await authorizeUserAdministration(options, operationId, caller, call));
}

/** The rules alone, of a user already read: for a call that only a superadmin makes. */
export async function requireMayAdministerUser(
  options: RulesOptions,
  operationId: string,
  caller: Caller,
  target: UserRecord | undefined,
  call: Omit<UserAdministrationCall, "userId"> = {}
): Promise<void> {
  requireAuthorized(await userAdministrationRule(options, operationId, caller, target, call));
}

/**
 * The rules of user administration, in order. The superadmin rules, which no right opens.
 * Nobody gives themselves a right, a reference of a tool included. Whoever changes an account holds every right the account
 * holds, since changing its password, sign-in, status or roles hands the account to them or
 * takes it from its owner. And whoever gives a role or a legacy key holds each action given.
 * `target` is the user as they are now, or nobody for a call that creates one.
 */
async function userAdministrationRule(
  options: RulesOptions,
  operationId: string,
  caller: Caller,
  target: UserRecord | undefined,
  call: Omit<UserAdministrationCall, "userId">
): Promise<OperationAuthorization> {
  const roleRights = {
    clientInstanceId: options.clientInstanceId,
    access: options.stores.access,
    roles: options.stores.roles
  };
  const named =
    superadminRuleAgainst(caller.actor, target, call) ??
    (await superadminRoleRuleAgainst(roleRights, caller.actor, target, call));
  if (named !== undefined) return superadminRuleRefusal(operationId, named);
  const given = await rightsGiven(roleRights, target, call);
  if (target !== undefined && target.id === caller.actor.id && given.length > 0) {
    return {
      allowed: false,
      action: operationId,
      reason: "holder_not_administrable",
      message: "Nobody gives themselves a role or a right: another holder of it gives it"
    };
  }
  const rights = { clientInstanceId: options.clientInstanceId, access: options.stores.access };
  if (target !== undefined) {
    const account = await authorizeHeldRightsWithin(
      rights,
      caller.access,
      await personRights({ ...rights, workspaces: options.stores.workspaces }, target),
      { changes: { label: target.displayLabel } }
    );
    if (!account.allowed) return account;
  }
  return authorizeHeldRightsWithin(rights, caller.access, given, {
    gives: { label: target?.displayLabel ?? call.displayLabel ?? "the new user" }
  });
}

/**
 * What a call gives: each role it adds, as the rights the role holds now, each at its scope;
 * each legacy key it adds or whose revocation it removes; and each reference of a tool it
 * adds, as the action `ref:<reference>`, which only a holder of the reference holds. Removing
 * a role, a key or a reference, or adding a revocation, takes away and gives nothing. An entry
 * that is no key, the release key, which a person never carries, and a role the instance does
 * not have are left to the operation, which refuses them by name.
 */
async function rightsGiven(
  options: RoleRightsOptions,
  target: Pick<UserRecord, "roles" | "permissions" | "permissionRefs"> | undefined,
  call: UserRightsChange
): Promise<HeldRight[]> {
  const refs = (call.permissionRefs ?? [])
    .filter((ref) => !target?.permissionRefs.includes(ref))
    .map((ref) => ({ action: `${PERMISSION_REF_ACTION_PREFIX}${ref}` }));
  const roleRights: HeldRight[] = [];
  for (const role of addedRoles(target, call)) {
    const grants = (await currentRoleGrants(options, role)) ?? [];
    const allows = grants.filter((grant) => grant.effect === "allow");
    roleRights.push(...(await rightsOfGrants(options, allows)));
  }
  const existing = target?.permissions ?? [];
  const keys = changedPermissionEntries(call.permissions, existing)
    .flatMap((entry) => {
      if (!entry.startsWith("!")) return existing.includes(entry) ? [] : [entry];
      // A revocation that the call removes gives the key back.
      return existing.includes(entry) ? [entry.slice(1)] : [];
    })
    .filter((key) => isPermission(key) && key !== RELEASE_KEY)
    .map((action) => ({ action }));
  const rights = new Map<string, HeldRight>();
  for (const right of [...roleRights, ...keys, ...refs]) rights.set(JSON.stringify(right), right);
  return [...rights.values()];
}

function addedRoles(target: Pick<UserRecord, "roles"> | undefined, call: UserRightsChange) {
  return (call.roles ?? []).filter((role) => !target?.roles.includes(role));
}

/**
 * Only a superadmin gives or takes a role that carries a right only a superadmin hands out
 * (`SUPERADMIN_GRANTED_ACTIONS`), as it is now. The sentence a refused caller reads, or nothing.
 */
async function superadminRoleRuleAgainst(
  options: RoleRightsOptions,
  actor: AuthenticatedIdentity,
  target: Pick<UserRecord, "roles"> | undefined,
  call: UserRightsChange
): Promise<string | undefined> {
  if (isSuperadminActor(actor) || call.roles === undefined) return undefined;
  const removed = (target?.roles ?? []).filter((role) => !call.roles?.includes(role));
  for (const role of [...addedRoles(target, call), ...removed]) {
    const grants = await currentRoleGrants(options, role);
    if (grants && carriesSuperadminGrantedAction(grants)) {
      return `Only a superadmin may give or take the role '${role}', which carries a right only a superadmin hands out`;
    }
  }
  return undefined;
}

/**
 * The rules of user administration that depend on the superadmin role, as the sentence a
 * refused caller reads, or nothing where the actor may. A superadmin passes them all. Anybody
 * else may not change a superadmin, may not give the superadmin role, and may not give or take
 * a right only a superadmin assigns.
 */
function superadminRuleAgainst(
  actor: AuthenticatedIdentity,
  target: Pick<UserRecord, "roles" | "permissions"> | undefined,
  call: Omit<UserAdministrationCall, "userId">
): string | undefined {
  if (isSuperadminActor(actor)) return undefined;
  if (call.superadminOnly) return "Only a superadmin may delete a user";
  if (target && isSuperadmin(target)) return "Only a superadmin may change a superadmin";
  if (call.roles && isSuperadmin({ roles: [...call.roles] })) {
    return "Only a superadmin may assign the superadmin role";
  }
  const assigned = changedPermissionEntries(call.permissions, target?.permissions)
    .map((permission) => permission.replace(/^!/u, ""))
    .find((permission) => isSuperadminGrantedAction(permission));
  return assigned === undefined
    ? undefined
    : `Only a superadmin may give or take the right '${assigned}'`;
}

function superadminRuleRefusal(operationId: string, message: string): OperationAuthorization {
  return { allowed: false, action: operationId, reason: "no_grant", message };
}

function isSuperadminActor(actor: AuthenticatedIdentity): boolean {
  return !isAuthenticatedServicePrincipal(actor) && isSuperadmin(actor);
}
