import type { ApiUser } from "@vivd-stage/api-client";

export function canViewSuperadminPanel(user: ApiUser | undefined): boolean {
  return Boolean(user?.roles.includes("superadmin"));
}
