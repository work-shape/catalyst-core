import { AppError } from "./errors";
import type { AuthenticatedUser } from "./identity";

export const PERMISSIONS = [
  "config_assets.read",
  "config_assets.write",
  "usage.view",
  "users.manage",
  "audit.view"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_DEFAULT_PERMISSIONS: Record<
  "user" | "admin" | "superadmin",
  readonly Permission[]
> = {
  user: [],
  admin: PERMISSIONS,
  superadmin: PERMISSIONS
};

export function resolveEffectivePermissions(
  subject: Pick<AuthenticatedUser, "roles" | "permissions">
): ReadonlySet<Permission> {
  const effective = new Set<Permission>();
  const revocations = new Set<Permission>();

  for (const role of subject.roles) {
    if (isDefaultPermissionRole(role)) {
      for (const permission of ROLE_DEFAULT_PERMISSIONS[role]) {
        effective.add(permission);
      }
    }
  }

  for (const entry of subject.permissions ?? []) {
    const revoked = entry.startsWith("!");
    const permission = revoked ? entry.slice(1) : entry;
    if (!isPermission(permission)) {
      continue;
    }
    if (revoked) {
      revocations.add(permission);
    } else {
      effective.add(permission);
    }
  }

  for (const permission of revocations) {
    effective.delete(permission);
  }

  return effective;
}

export function hasPermission(
  subject: Pick<AuthenticatedUser, "roles" | "permissions">,
  permission: Permission
): boolean {
  return resolveEffectivePermissions(subject).has(permission);
}

export function requirePermission(
  subject: Pick<AuthenticatedUser, "roles" | "permissions">,
  permission: Permission
): void {
  if (!hasPermission(subject, permission)) {
    throw new AppError("FORBIDDEN", `Missing permission '${permission}'`);
  }
}

function isDefaultPermissionRole(role: string): role is keyof typeof ROLE_DEFAULT_PERMISSIONS {
  return role === "user" || role === "admin" || role === "superadmin";
}

function isPermission(permission: string): permission is Permission {
  return PERMISSIONS.includes(permission as Permission);
}
