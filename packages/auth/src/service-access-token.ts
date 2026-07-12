import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AppError,
  asApiCredentialId,
  asClientInstanceId,
  asServicePrincipalId,
  authScopeForPermission,
  hashApiCredentialSecret,
  isPermission,
  parseApiCredentialSecret,
  permissionForAuthScope,
  resolveEffectivePermissions,
  type ApiAccessStore,
  type AuthenticatedServicePrincipal,
  type AuthScope,
  type ClientInstanceId,
  type ISODateString,
  type ResolvedApiCredential
} from "@vivd-catalyst/core";
import type { AuthAdapter, AuthRequest, AuthRequestHeaders } from "./types";

const SERVICE_ACCESS_TOKEN_TYPE = "catalyst-service-access";
const SERVICE_ACCESS_TOKEN_AUDIENCE = "catalyst-service-api";

interface ServiceAccessTokenClaims {
  typ: typeof SERVICE_ACCESS_TOKEN_TYPE;
  aud: typeof SERVICE_ACCESS_TOKEN_AUDIENCE;
  sub: string;
  credentialId: string;
  clientInstanceId: string;
  scopes: string[];
  iss: string;
  iat: number;
  exp: number;
}

export interface ServiceAccessTokenOptions {
  secret: string;
  clientInstanceId: ClientInstanceId | string;
  issuer?: string;
  ttlSeconds?: number;
  apiAccessStore: ApiAccessStore;
}

interface EffectiveServiceGrants {
  scopes: AuthScope[];
  permissions: string[];
}

export class ApiKeyAccessTokenExchange {
  private readonly options: Required<Pick<ServiceAccessTokenOptions, "issuer" | "ttlSeconds">> &
    ServiceAccessTokenOptions;

  constructor(options: ServiceAccessTokenOptions) {
    validateOptions(options);
    this.options = withDefaults(options);
  }

  async exchange(apiKey: string): Promise<{
    accessToken: string;
    expiresAt: ISODateString;
    principal: AuthenticatedServicePrincipal;
  }> {
    const credentialId = parseApiCredentialSecret(apiKey);
    if (!credentialId) {
      throw new AppError("UNAUTHENTICATED", "Invalid API key");
    }
    const resolved = await this.options.apiAccessStore.resolveApiCredential({
      clientInstanceId: asClientInstanceId(String(this.options.clientInstanceId)),
      credentialId
    });
    if (!resolved) {
      throw new AppError("UNAUTHENTICATED", "Invalid API key");
    }
    const presentedHash = await hashApiCredentialSecret(apiKey);
    if (!safeEqual(presentedHash, resolved.secretHash)) {
      throw new AppError("UNAUTHENTICATED", "Invalid API key");
    }
    assertCredentialUsable(resolved);
    const grants = deriveEffectiveServiceGrants(resolved);
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + this.options.ttlSeconds;
    const claims: ServiceAccessTokenClaims = {
      typ: SERVICE_ACCESS_TOKEN_TYPE,
      aud: SERVICE_ACCESS_TOKEN_AUDIENCE,
      sub: resolved.servicePrincipal.id,
      credentialId: resolved.credential.id,
      clientInstanceId: String(resolved.servicePrincipal.clientInstanceId),
      scopes: grants.scopes,
      iss: this.options.issuer,
      iat: issuedAt,
      exp: expiresAt
    };
    await this.options.apiAccessStore.updateApiCredentialLastUsed({
      clientInstanceId: resolved.servicePrincipal.clientInstanceId,
      credentialId: resolved.credential.id
    });
    return {
      accessToken: signClaims(claims, this.options.secret),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      principal: toAuthenticatedServicePrincipal(resolved, grants)
    };
  }
}

export class HmacServiceAccessTokenAuthAdapter implements AuthAdapter {
  readonly id = "service-access-token";
  private readonly options: Required<Pick<ServiceAccessTokenOptions, "issuer" | "ttlSeconds">> &
    ServiceAccessTokenOptions;

  constructor(options: ServiceAccessTokenOptions) {
    validateOptions(options);
    this.options = withDefaults(options);
  }

  async authenticate(request: AuthRequest): Promise<AuthenticatedServicePrincipal> {
    const token = extractBearerToken(request.headers);
    if (!token) {
      throw new AppError("UNAUTHENTICATED", "Missing bearer token");
    }
    const claims = verifyClaims(token, this.options.secret);
    if (
      claims.typ !== SERVICE_ACCESS_TOKEN_TYPE ||
      claims.aud !== SERVICE_ACCESS_TOKEN_AUDIENCE ||
      claims.iss !== this.options.issuer
    ) {
      throw new AppError("UNAUTHENTICATED", "Invalid service access token");
    }
    if (claims.clientInstanceId !== String(this.options.clientInstanceId)) {
      throw new AppError("FORBIDDEN", "Token was issued for another client instance");
    }
    if (claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new AppError("UNAUTHENTICATED", "Service access token is expired");
    }
    const credentialId = asApiCredentialId(claims.credentialId);
    const resolved = await this.options.apiAccessStore.resolveApiCredential({
      clientInstanceId: asClientInstanceId(claims.clientInstanceId),
      credentialId
    });
    if (!resolved || resolved.servicePrincipal.id !== claims.sub) {
      throw new AppError("UNAUTHENTICATED", "Service access token is no longer valid");
    }
    assertCredentialUsable(resolved);
    const current = deriveEffectiveServiceGrants(resolved);
    const claimedScopes = new Set(claims.scopes);
    const scopes = current.scopes.filter((scope) => claimedScopes.has(scope));
    const permissions = scopes.flatMap((scope) => {
      const permission = permissionForAuthScope(scope);
      return permission ? [permission] : [];
    });
    return toAuthenticatedServicePrincipal(resolved, { scopes, permissions }, request.correlationId);
  }
}

export function extractApiKey(headers: AuthRequestHeaders): string | undefined {
  return extractBearerToken(headers);
}

function deriveEffectiveServiceGrants(resolved: ResolvedApiCredential): EffectiveServiceGrants {
  const principalScopes = new Map<string, string>();
  for (const permission of resolveEffectivePermissions(resolved.servicePrincipal)) {
    const scope = authScopeForPermission(permission);
    if (scope) {
      principalScopes.set(scope, permission);
    }
  }
  const restrictions = resolved.credential.scopes?.map((entry) => {
    if (isPermission(entry)) {
      return authScopeForPermission(entry) ?? entry;
    }
    return entry;
  });
  const selectedScopes = restrictions ?? [...principalScopes.keys()];
  const scopes = [...new Set(selectedScopes)]
    .filter((scope) => scope !== "*" && principalScopes.has(scope)) as AuthScope[];
  return {
    scopes,
    permissions: scopes.map((scope) => principalScopes.get(scope)!).filter(Boolean)
  };
}

function assertCredentialUsable(resolved: ResolvedApiCredential): void {
  if (resolved.servicePrincipal.status !== "active") {
    throw new AppError("UNAUTHENTICATED", "Service principal is disabled");
  }
  if (resolved.credential.revokedAt) {
    throw new AppError("UNAUTHENTICATED", "API credential is revoked");
  }
  if (
    resolved.credential.expiresAt &&
    Date.parse(resolved.credential.expiresAt) <= Date.now()
  ) {
    throw new AppError("UNAUTHENTICATED", "API credential is expired");
  }
}

function toAuthenticatedServicePrincipal(
  resolved: ResolvedApiCredential,
  grants: EffectiveServiceGrants,
  correlationId?: string
): AuthenticatedServicePrincipal {
  return {
    kind: "service",
    id: asServicePrincipalId(resolved.servicePrincipal.id),
    credentialId: asApiCredentialId(resolved.credential.id),
    displayLabel: resolved.servicePrincipal.displayLabel,
    permissionRefs: resolved.servicePrincipal.permissionRefs,
    permissions: grants.permissions,
    clientInstanceId: resolved.servicePrincipal.clientInstanceId,
    authSource: "service-access-token",
    correlationId,
    scopes: grants.scopes
  };
}

function validateOptions(options: ServiceAccessTokenOptions): void {
  if (options.secret.length < 32) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Service access token secret must be at least 32 characters"
    );
  }
  const ttlSeconds = options.ttlSeconds ?? 900;
  if (ttlSeconds < 600 || ttlSeconds > 900) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Service access token TTL must be between 10 and 15 minutes"
    );
  }
}

function withDefaults(options: ServiceAccessTokenOptions) {
  return {
    ...options,
    issuer: options.issuer ?? "vivd-catalyst",
    ttlSeconds: options.ttlSeconds ?? 900
  };
}

function extractBearerToken(headers: AuthRequestHeaders): string | undefined {
  const authorization = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value?.startsWith("Bearer ")) {
    return undefined;
  }
  return value.slice("Bearer ".length).trim() || undefined;
}

function signClaims(claims: ServiceAccessTokenClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${signatureFor(payload, secret)}`;
}

function verifyClaims(token: string, secret: string): ServiceAccessTokenClaims {
  const segments = token.split(".");
  if (segments.length !== 2) {
    throw new AppError("UNAUTHENTICATED", "Malformed service access token");
  }
  const [payload, signature] = segments;
  if (!payload || !signature || !safeEqual(signature, signatureFor(payload, secret))) {
    throw new AppError("UNAUTHENTICATED", "Invalid service access token signature");
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ServiceAccessTokenClaims;
    if (
      !claims.sub ||
      !claims.credentialId ||
      !claims.clientInstanceId ||
      !Array.isArray(claims.scopes) ||
      typeof claims.exp !== "number"
    ) {
      throw new Error("missing claims");
    }
    return claims;
  } catch {
    throw new AppError("UNAUTHENTICATED", "Malformed service access token claims");
  }
}

function signatureFor(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
