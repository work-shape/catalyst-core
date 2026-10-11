import {
  AppError,
  asUserId,
  isAuthenticatedServicePrincipal,
  isSuperadmin,
  type AuthenticatedIdentity,
  type OperationAuthorization,
  type OperationAuthorizeContext,
  type UserRecord,
  type UserRole
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

/** The right every user administration operation asks for, on the instance. */
const USERS_MANAGE_ACTION = "users.manage";

/**
 * Rights only a superadmin gives or takes away, granted or revoked (`!right`). An admin does
 * not change them for anybody, themselves included.
 */
const SUPERADMIN_ASSIGNED_PERMISSIONS: ReadonlySet<string> = new Set([
  "api_access.manage",
  "agent_models.manage"
]);

/** What a call changes about a user's roles and directly held rights, as far as it names them. */
interface UserRightsChange {
  roles?: readonly UserRole[];
  permissions?: readonly string[];
}

/** The call as the rules read it: whom it changes, and what of their rights. */
interface UserAdministrationCall extends UserRightsChange {
  /** The user the call changes. A call that creates one names none. */
  userId?: string;
  /** Only a superadmin makes this call at all: deleting a user. */
  superadminOnly?: true;
}

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
 * The rules of user administration that depend on the superadmin role, as the sentence a
 * refused caller reads, or nothing where the actor may. A superadmin may make every change.
 * Anybody else may not change a superadmin, may not give the superadmin role, and may not give
 * or take a right only a superadmin assigns. `target` is the user as they are now, or nobody
 * for a call that creates one.
 */
function superadminRuleAgainst(
  actor: AuthenticatedIdentity,
  target: Pick<UserRecord, "roles" | "permissions"> | undefined,
  call: Pick<UserAdministrationCall, "roles" | "permissions" | "superadminOnly"> = {}
): string | undefined {
  if (isSuperadminActor(actor)) return undefined;
  if (call.superadminOnly) return "Only a superadmin may delete a user";
  if (target && isSuperadmin(target)) return "Only a superadmin may change a superadmin";
  if (call.roles && isSuperadmin({ roles: [...call.roles] })) {
    return "Only a superadmin may assign the superadmin role";
  }
  const assigned = changedPermissionEntries(call.permissions, target?.permissions)
    .map((permission) => permission.replace(/^!/u, ""))
    .find((permission) => SUPERADMIN_ASSIGNED_PERMISSIONS.has(permission));
  return assigned === undefined
    ? undefined
    : `Only a superadmin may give or take the right '${assigned}'`;
}

/**
 * Who may call a user administration operation. It is the `authorize` of the seven changing
 * operations, so the run records the check and a refusal, and nothing of the operation runs
 * for anybody else. `users.manage` is asked first, so a caller without it causes no read. A
 * refusal by a superadmin rule names the operation and says the rule, since no right a caller
 * can be granted opens it. A user that does not exist passes: the operation answers that
 * itself.
 */
export async function authorizeUserAdministration(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  operationId: string,
  { actor, access }: Pick<OperationAuthorizeContext, "actor" | "access">,
  call: UserAdministrationCall
): Promise<OperationAuthorization> {
  const right = access.authorize(USERS_MANAGE_ACTION);
  if (!right.allowed) {
    return { allowed: false, action: USERS_MANAGE_ACTION, reason: right.reason };
  }
  // A service principal administers no user, whatever it was granted.
  if (isAuthenticatedServicePrincipal(actor)) {
    return {
      allowed: false,
      action: operationId,
      reason: "no_grant",
      message: "Only a signed-in user may administer users"
    };
  }
  if (isSuperadmin(actor)) return { allowed: true };
  // Deleting is refused whoever the user is, so that refusal causes no read either.
  const target =
    call.superadminOnly || call.userId === undefined
      ? undefined
      : await options.stores.users.getUser({
          clientInstanceId: options.clientInstanceId,
          userId: asUserId(call.userId)
        });
  const message = superadminRuleAgainst(actor, target, call);
  return message === undefined
    ? { allowed: true }
    : { allowed: false, action: operationId, reason: "no_grant", message };
}

function isSuperadminActor(actor: AuthenticatedIdentity): boolean {
  return !isAuthenticatedServicePrincipal(actor) && isSuperadmin(actor);
}

/**
 * The same rules, asked again inside the operation on the user as they are when it writes: a
 * user may have become a superadmin since the call was admitted. The refusal ends the run as
 * denied, like the one before it.
 */
export function requireMayAdministerUser(
  operationId: string,
  actor: AuthenticatedIdentity,
  target: Pick<UserRecord, "roles" | "permissions"> | undefined,
  call: Pick<UserAdministrationCall, "roles" | "permissions" | "superadminOnly"> = {}
): void {
  const message = superadminRuleAgainst(actor, target, call);
  if (message !== undefined) {
    throw new AppError("FORBIDDEN", message, { action: operationId, reason: "no_grant" });
  }
}
