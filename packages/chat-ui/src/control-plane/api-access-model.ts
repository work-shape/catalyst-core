import type { ApiCredentialScope, ServicePrincipalPermission } from "@vivd-catalyst/api-client";

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

export function isCredentialActive(
  input: {
    revokedAt?: string;
    expiresAt?: string;
  },
  now = new Date()
): boolean {
  if (input.revokedAt) {
    return false;
  }
  return !input.expiresAt || new Date(input.expiresAt).getTime() > now.getTime();
}

export type SecretField = "server" | "key";

export interface SecretCopyState {
  copied?: SecretField;
  failed?: boolean;
}

/** A copy result together with the secret of the credential it was recorded for. */
export interface RecordedSecretCopy {
  secret: string;
  state: SecretCopyState;
}

/**
 * The copy result to show for a credential. A result recorded for another credential is
 * dropped, so the dialog starts clean when it opens for the next one.
 */
export function copyStateFor(
  recorded: RecordedSecretCopy | undefined,
  secret: string
): SecretCopyState {
  return recorded?.secret === secret ? recorded.state : {};
}
