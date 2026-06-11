import type { ApiUser } from "@vivd-catalyst/api-client";

export function canViewSuperadminPanel(user: ApiUser | undefined): boolean {
  return Boolean(user?.roles.includes("superadmin"));
}
