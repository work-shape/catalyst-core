import {
  AppError,
  hasAuthScope,
  isSuperadmin,
  type ActorAccess,
  type AuthenticatedUser,
  type OperationAuthorization,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  SERVICE_PRINCIPALS_ACTION,
  authorizePrincipalAdministration
} from "./api-access-administration-workflow";

// Who writes a grant row for which holder, as the access workflow asks it before the policy
// and again where it writes.

/** What a credential carries to change, and to read, service principals. */
const API_ACCESS_WRITE_SCOPE = "api_access:write";
const API_ACCESS_READ_SCOPE = "api_access:read";

/**
 * No right is missing that the caller could be given, so the refusal names the operation and
 * its text says who writes the row.
 */
export function holderNotAdministrable(operation: string, message: string): OperationAuthorization {
  return { allowed: false, action: operation, reason: "holder_not_administrable", message };
}

/** Whom the list of service principals is shown to, and so the rows they hold. */
export function seesPrincipals(actor: AuthenticatedUser, access: ActorAccess): boolean {
  return (
    access.authorize(SERVICE_PRINCIPALS_ACTION).allowed &&
    hasAuthScope(actor, API_ACCESS_READ_SCOPE)
  );
}

/**
 * Who writes a service principal's grant row: whoever administers service principals, by that
 * one check and no second rule. The credential is asked what the operations that administer
 * principals ask of it, so a key issued for managing users writes no row for a principal.
 */
export function authorizePrincipalHolderWrite(
  actor: AuthenticatedUser,
  access: ActorAccess,
  operation: string
): OperationAuthorization {
  const administration = authorizePrincipalAdministration({ actor, access }, operation);
  if (!administration.allowed) {
    return administration;
  }
  return hasAuthScope(actor, API_ACCESS_WRITE_SCOPE)
    ? { allowed: true }
    : {
        allowed: false,
        // The right is held. What is missing is a scope of the credential, and it is named.
        action: `auth_scope:${API_ACCESS_WRITE_SCOPE}`,
        reason: "no_grant",
        message: `Missing auth scope '${API_ACCESS_WRITE_SCOPE}'`
      };
}

export { requireAuthorized } from "./rights-held";

/**
 * Nobody writes a row of their own: an allow would give themselves a right, and one they hold
 * already would outlast the role it came from. No right opens it, so the operation is named.
 */
export function ownRowRefusal(operation: string): OperationAuthorization {
  return holderNotAdministrable(
    operation,
    "Nobody writes or lifts a grant of their own: another holder of the right does"
  );
}

/** A caller who is not a superadmin writes no row for a holder who is one. */
export function mayManageHolder(actor: AuthenticatedUser, holder: UserRecord): boolean {
  return !isSuperadmin(holder) || isSuperadmin(actor);
}

export function requireManageableHolder(actor: AuthenticatedUser, holder: UserRecord): void {
  if (!mayManageHolder(actor, holder)) {
    throw new AppError("FORBIDDEN", "Only superadmins can manage superadmin users");
  }
}
