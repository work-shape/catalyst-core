import { AppError } from "./errors";
import type { AuthenticatedServicePrincipal, AuthenticatedUser } from "./identity";

export const PERMISSIONS = [
  "config_assets.read",
  "config_assets.write",
  "config_assets.release",
  "usage.view",
  "users.manage",
  "audit.view"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ADMIN_PERMISSIONS = PERMISSIONS.filter(
  (permission) => permission !== "config_assets.release"
);

export const ROLE_DEFAULT_PERMISSIONS: Record<
  "user" | "admin" | "superadmin",
  readonly Permission[]
> = {
  user: [],
  admin: ADMIN_PERMISSIONS,
  superadmin: ADMIN_PERMISSIONS
};

export function resolveEffectivePermissions(
  subject:
    | Pick<AuthenticatedUser, "roles" | "permissions">
    | Pick<AuthenticatedServicePrincipal, "permissions">
): ReadonlySet<Permission> {
  const effective = new Set<Permission>();
  const revocations = new Set<Permission>();

  for (const role of "roles" in subject ? subject.roles : []) {
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
  subject:
    | Pick<AuthenticatedUser, "roles" | "permissions">
    | Pick<AuthenticatedServicePrincipal, "permissions">,
  permission: Permission
): boolean {
  return resolveEffectivePermissions(subject).has(permission);
}

export function requirePermission(
  subject:
    | Pick<AuthenticatedUser, "roles" | "permissions">
    | Pick<AuthenticatedServicePrincipal, "permissions">,
  permission: Permission
): void {
  if (!hasPermission(subject, permission)) {
    throw new AppError("FORBIDDEN", `Missing permission '${permission}'`);
  }
}

function isDefaultPermissionRole(role: string): role is keyof typeof ROLE_DEFAULT_PERMISSIONS {
  return role === "user" || role === "admin" || role === "superadmin";
}

export function isPermission(permission: string): permission is Permission {
  return PERMISSIONS.includes(permission as Permission);
}

const PERMISSION_AUTH_SCOPES: Partial<Record<Permission, string>> = {
  "config_assets.read": "config_assets:read",
  "config_assets.write": "config_assets:write",
  "config_assets.release": "config_assets:release",
  "usage.view": "governance:read",
  "users.manage": "user_admin:write",
  "audit.view": "governance:read"
};

export function authScopeForPermission(permission: Permission): string | undefined {
  return PERMISSION_AUTH_SCOPES[permission];
}

export function permissionForAuthScope(scope: string): Permission | undefined {
  return PERMISSIONS.find((permission) => PERMISSION_AUTH_SCOPES[permission] === scope);
}
