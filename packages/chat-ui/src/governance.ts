import type { ApiUser } from "@vivd-catalyst/api-client";

export function canViewAdministrationPanel(user: ApiUser | undefined): boolean {
  return (
    canViewUsageGovernance(user) ||
    canManageUsers(user) ||
    canManageApiAccess(user) ||
    canViewAudit(user) ||
    canEditConfigAssets(user)
  );
}

export function canViewSuperadminPanel(user: ApiUser | undefined): boolean {
  return canViewAdministrationPanel(user);
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

export function canViewAudit(user: ApiUser | undefined): boolean {
  return hasPermission(user, "audit.view");
}

export function canEditConfigAssets(user: ApiUser | undefined): boolean {
  return hasPermission(user, "config_assets.read");
}

function hasPermission(user: ApiUser | undefined, permission: string): boolean {
  return Boolean(user?.permissions.includes(permission));
}
