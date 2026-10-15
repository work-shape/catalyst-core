import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AppError,
  asApiCredentialId,
  asClientInstanceId,
  asServicePrincipalId,
  asUserId,
  authenticatedUserFromRecord,
  authScopeForPermission,
  hashApiCredentialSecret,
  isPermission,
  operationScopesOfPersonalApiKey,
  parseApiCredentialSecret,
  permissionForAuthScope,
  type ApiAccessStore,
  type ApiCredentialId,
  type AuthenticatedServicePrincipal,
  type AuthenticatedUser,
  type AuthScope,
  type ClientInstanceId,
  type ISODateString,
  type PersonalApiKeyStore,
  type ResolvedApiCredential,
  type ResolvedPersonalApiKey,
  type UserStore
} from "@work-shape/catalyst-core";
import type { AuthAdapter, AuthRequest, AuthRequestHeaders } from "./types";

const SERVICE_ACCESS_TOKEN_TYPE = "catalyst-service-access";
const SERVICE_ACCESS_TOKEN_AUDIENCE = "catalyst-service-api";

/** How the access token of a personal API key names its subject, the key's owner. */
const PERSONAL_KEY_AUTH_SOURCE = "personal-api-key";

interface ServiceAccessTokenClaims {
  typ: typeof SERVICE_ACCESS_TOKEN_TYPE;
  aud: typeof SERVICE_ACCESS_TOKEN_AUDIENCE;
  /** Absent for a service principal's key, which is how tokens before personal keys read. */
  owner?: "user";
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
  /**
   * Where personal API keys are read, on an instance that has them. Without it a personal key
   * is refused: the instance has them turned off.
   */
  personalApiKeys?: {
    store: PersonalApiKeyStore;
    users: Pick<UserStore, "getUser">;
  };
}

/** Who an access token acts as: a service principal, or the owner of a personal key. */
export type ApiKeyIdentity = AuthenticatedServicePrincipal | AuthenticatedUser;

export interface EffectiveServiceGrants {
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
    identity: ApiKeyIdentity;
  }> {
    const credentialId = parseApiCredentialSecret(apiKey);
    if (!credentialId) {
      throw new AppError("UNAUTHENTICATED", "Invalid API key");
    }
    const clientInstanceId = asClientInstanceId(String(this.options.clientInstanceId));
    const presentedHash = await hashApiCredentialSecret(apiKey);
    const resolved = await this.options.apiAccessStore.resolveApiCredential({
      clientInstanceId,
      credentialId
    });
    if (resolved) {
      if (!safeEqual(presentedHash, resolved.secretHash)) {
        throw new AppError("UNAUTHENTICATED", "Invalid API key");
      }
      assertCredentialUsable(resolved);
      const grants = deriveEffectiveServiceGrants(resolved);
      await this.options.apiAccessStore.updateApiCredentialLastUsed({
        clientInstanceId: resolved.servicePrincipal.clientInstanceId,
        credentialId: resolved.credential.id
      });
      return this.issue(
        { sub: resolved.servicePrincipal.id, credentialId: resolved.credential.id },
        grants.scopes,
        toAuthenticatedServicePrincipal(resolved, grants)
      );
    }
    const personal = await resolvePersonalKey(this.options, clientInstanceId, credentialId);
    if (!safeEqual(presentedHash, personal.secretHash)) {
      throw new AppError("UNAUTHENTICATED", "Invalid API key");
    }
    const identity = await personalKeyIdentity(this.options, personal);
    await this.options.personalApiKeys?.store.markPersonalApiKeyUsed({
      clientInstanceId,
      keyId: personal.key.id
    });
    return this.issue(
      { owner: "user", sub: personal.key.ownerUserId, credentialId: personal.key.id },
      identity.scopes ?? [],
      identity
    );
  }

  private issue(
    subject: Pick<ServiceAccessTokenClaims, "owner" | "sub" | "credentialId">,
    scopes: AuthScope[],
    identity: ApiKeyIdentity
  ) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + this.options.ttlSeconds;
    const claims: ServiceAccessTokenClaims = {
      typ: SERVICE_ACCESS_TOKEN_TYPE,
      aud: SERVICE_ACCESS_TOKEN_AUDIENCE,
      ...subject,
      clientInstanceId: String(this.options.clientInstanceId),
      scopes,
      iss: this.options.issuer,
      iat: issuedAt,
      exp: expiresAt
    };
    return {
      accessToken: signClaims(claims, this.options.secret),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      identity
    };
  }
}

export class HmacServiceAccessTokenAuthAdapter implements AuthAdapter {
  readonly id = "service-access-token";
  readonly credentialMode = "explicit";
  private readonly options: Required<Pick<ServiceAccessTokenOptions, "issuer" | "ttlSeconds">> &
    ServiceAccessTokenOptions;

  constructor(options: ServiceAccessTokenOptions) {
    validateOptions(options);
    this.options = withDefaults(options);
  }

  async authenticate(request: AuthRequest): Promise<ApiKeyIdentity> {
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
    if (claims.owner === "user") {
      // The key, its owner and the owner's rights are read again on every call: a revoked
      // key, a disabled owner or a removed grant ends what the token allows at once.
      const personal = await resolvePersonalKey(
        this.options,
        asClientInstanceId(claims.clientInstanceId),
        credentialId
      );
      if (personal.key.ownerUserId !== claims.sub) {
        throw new AppError("UNAUTHENTICATED", "Service access token is no longer valid");
      }
      const identity = await personalKeyIdentity(this.options, personal, request.correlationId);
      const claimedScopes = new Set(claims.scopes);
      return {
        ...identity,
        scopes: (identity.scopes ?? []).filter((scope) => claimedScopes.has(scope))
      };
    }
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
    return toAuthenticatedServicePrincipal(
      resolved,
      { scopes, permissions },
      request.correlationId
    );
  }
}

export function extractApiKey(headers: AuthRequestHeaders): string | undefined {
  return extractBearerToken(headers);
}

/**
 * The scopes a credential's token carries, those of its list that its principal's keys name,
 * and the keys behind them. The evaluator allows the principal's instance-wide rights of a key
 * only when the token carries that key, so the scopes cap the principal's rights as they did
 * before AP-4. A scope carries its first key (`permissionForAuthScope`), as a request's
 * token did before AP-4: `governance:read` carries `usage.view` whichever of `usage.view` and
 * `audit.view` the principal holds.
 */
export function deriveEffectiveServiceGrants(
  resolved: ResolvedApiCredential
): EffectiveServiceGrants {
  const principalScopes = new Set<string>();
  for (const permission of resolved.heldKeys.filter(isPermission)) {
    const scope = authScopeForPermission(permission);
    if (scope) {
      principalScopes.add(scope);
    }
  }
  const restrictions = resolved.credential.scopes?.map((entry) => {
    if (isPermission(entry)) {
      return authScopeForPermission(entry) ?? entry;
    }
    return entry;
  });
  const selectedScopes = restrictions ?? [...principalScopes];
  const scopes = [...new Set(selectedScopes)].filter(
    (scope) => scope !== "*" && principalScopes.has(scope)
  ) as AuthScope[];
  return {
    scopes,
    permissions: scopes.flatMap((scope) => {
      const permission = permissionForAuthScope(scope);
      return permission === undefined ? [] : [permission];
    })
  };
}

/** The personal key of the id, or the refusal a caller reads for a key that is not one. */
async function resolvePersonalKey(
  options: ServiceAccessTokenOptions,
  clientInstanceId: ClientInstanceId,
  keyId: ApiCredentialId
): Promise<ResolvedPersonalApiKey> {
  const personal = options.personalApiKeys
    ? await options.personalApiKeys.store.resolvePersonalApiKey({ clientInstanceId, keyId })
    : undefined;
  if (!personal) {
    throw new AppError("UNAUTHENTICATED", "Invalid API key");
  }
  if (personal.key.revokedAt) {
    throw new AppError("UNAUTHENTICATED", "API credential is revoked");
  }
  if (Date.parse(personal.key.expiresAt) <= Date.now()) {
    throw new AppError("UNAUTHENTICATED", "API credential is expired");
  }
  return personal;
}

/**
 * The owner of a personal key as the actor of a call: their record as it is now, the key as
 * the delegated actor, and the key's scopes, which the authorizer intersects with the owner's
 * rights. A disabled owner is refused.
 */
async function personalKeyIdentity(
  options: ServiceAccessTokenOptions,
  personal: ResolvedPersonalApiKey,
  correlationId?: string
): Promise<AuthenticatedUser> {
  const user = await options.personalApiKeys?.users.getUser({
    clientInstanceId: personal.key.clientInstanceId,
    userId: asUserId(personal.key.ownerUserId)
  });
  if (!user) {
    throw new AppError("UNAUTHENTICATED", "Invalid API key");
  }
  const owner = authenticatedUserFromRecord({
    user,
    identity: { authSource: PERSONAL_KEY_AUTH_SOURCE, externalUserId: user.id },
    correlationId
  });
  return {
    ...owner,
    delegatedActor: {
      kind: "api_key",
      id: personal.key.id,
      displayLabel: personal.key.name,
      authSource: PERSONAL_KEY_AUTH_SOURCE
    },
    scopes: operationScopesOfPersonalApiKey(personal.key.scopes),
    keyScopes: personal.key.scopes
  };
}

function assertCredentialUsable(resolved: ResolvedApiCredential): void {
  if (resolved.servicePrincipal.status !== "active") {
    throw new AppError("UNAUTHENTICATED", "Service principal is disabled");
  }
  if (resolved.credential.revokedAt) {
    throw new AppError("UNAUTHENTICATED", "API credential is revoked");
  }
  if (resolved.credential.expiresAt && Date.parse(resolved.credential.expiresAt) <= Date.now()) {
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
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as ServiceAccessTokenClaims;
    if (
      (claims.owner !== undefined && claims.owner !== "user") ||
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
