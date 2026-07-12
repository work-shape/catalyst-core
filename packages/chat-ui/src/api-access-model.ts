import type {
  ApiCredentialScope,
  ServicePrincipalPermission
} from "@vivd-catalyst/api-client";

export const DEFAULT_SERVICE_PRINCIPAL_PERMISSIONS: ServicePrincipalPermission[] = [
  "config_assets.read"
];

export const SERVICE_PRINCIPAL_PERMISSION_OPTIONS: ReadonlyArray<{
  permission: ServicePrincipalPermission;
  scope: ApiCredentialScope;
}> = [
  { permission: "config_assets.read", scope: "config_assets:read" },
  { permission: "config_assets.release", scope: "config_assets:release" }
];

export function scopesAllowedByPermissions(
  permissions: readonly ServicePrincipalPermission[]
): ApiCredentialScope[] {
  return SERVICE_PRINCIPAL_PERMISSION_OPTIONS.flatMap(({ permission, scope }) =>
    permissions.includes(permission) ? [scope] : []
  );
}

export function constrainCredentialScopes(
  scopes: readonly ApiCredentialScope[],
  permissions: readonly ServicePrincipalPermission[]
): ApiCredentialScope[] {
  const allowed = scopesAllowedByPermissions(permissions);
  return allowed.filter((scope) => scopes.includes(scope));
}

export function optionalTrimmedValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function expiryInputToIso(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function isCredentialActive(input: {
  revokedAt?: string;
  expiresAt?: string;
}, now = new Date()): boolean {
  if (input.revokedAt) {
    return false;
  }
  return !input.expiresAt || new Date(input.expiresAt).getTime() > now.getTime();
}
