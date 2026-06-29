import type { ApiUser } from "@vivd-catalyst/api-client";

export function canViewAdministrationPanel(user: ApiUser | undefined): boolean {
  return Boolean(user?.roles.includes("admin") || user?.roles.includes("superadmin"));
}

export function canViewSuperadminPanel(user: ApiUser | undefined): boolean {
  return canViewUsageGovernance(user);
}

export function canViewUsageGovernance(user: ApiUser | undefined): boolean {
  return Boolean(user?.roles.includes("superadmin"));
}
