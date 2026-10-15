import type { ApiUser, PlatformContext } from "@work-shape/catalyst-api-client";
import { STANDALONE_AUTH_SOURCE } from "../workspace-utils";

export function canViewAdministrationPanel(user: ApiUser | undefined): boolean {
  return (
    canViewUsageGovernance(user) ||
    canManageUsers(user) ||
    canManageApiAccess(user) ||
    canViewAudit(user) ||
    canEditConfigAssets(user)
  );
}

export function canViewUsageGovernance(user: ApiUser | undefined): boolean {
  return hasPermission(user, "usage.view");
}

export function canManageUsers(user: ApiUser | undefined): boolean {
  return hasPermission(user, "users.manage");
}

export function canManageApiAccess(user: ApiUser | undefined): boolean {
  return hasPermission(user, "api_access.manage");
}

/** A right of the instance itself, which the platform context tells and the user record does not. */
export function canManageServicePrincipals(
  platform: Pick<PlatformContext, "instanceActions"> | undefined
): boolean {
  return Boolean(platform?.instanceActions.includes("service_principals.manage"));
}

export function canViewAudit(user: ApiUser | undefined): boolean {
  return hasPermission(user, "audit.view");
}

export function canEditConfigAssets(user: ApiUser | undefined): boolean {
  return hasPermission(user, "config_assets.read");
}

export function canManageAgentModels(user: ApiUser | undefined): boolean {
  return hasPermission(user, "agent_models.manage");
}

/** True for an account that signs in with a password kept by this instance. */
export function canChangePassword(user: ApiUser | undefined): boolean {
  return user?.authSource === STANDALONE_AUTH_SOURCE;
}

function hasPermission(user: ApiUser | undefined, permission: string): boolean {
  return Boolean(user?.permissions.includes(permission));
}
