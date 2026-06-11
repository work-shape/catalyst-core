import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AppError,
  type AuthenticatedUser,
  type ClientInstanceId,
  type ISODateString,
  asClientInstanceId
} from "@vivd-stage/core";
import type { AuthAdapter, AuthRequest, AuthRequestHeaders } from "./types";

export interface SessionTokenInput {
  externalUserId: string;
  displayLabel: string;
  email?: string;
  emailVerified?: boolean;
  roles?: string[];
  permissionRefs?: string[];
  correlationId?: string;
}

interface SessionTokenClaims {
  sub: string;
  displayLabel: string;
  email?: string;
  emailVerified?: boolean;
  roles: string[];
  permissionRefs: string[];
  clientInstanceId: string;
  authSource: string;
  iss: string;
  iat: number;
  exp: number;
  correlationId?: string;
}

export interface HmacSessionTokenOptions {
  secret: string;
  clientInstanceId: ClientInstanceId | string;
  issuer: string;
  ttlSeconds: number;
  authSource?: string;
}

export class HmacSessionTokenIssuer {
  private readonly options: HmacSessionTokenOptions;

  constructor(options: HmacSessionTokenOptions) {
    if (options.secret.length < 24) {
      throw new AppError("VALIDATION_FAILED", "Session token secret must be at least 24 characters");
    }
    this.options = options;
  }

  issue(input: SessionTokenInput): { chatSessionToken: string; expiresAt: ISODateString } {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + this.options.ttlSeconds;
    const claims: SessionTokenClaims = {
      sub: input.externalUserId,
      displayLabel: input.displayLabel,
      email: input.email,
      emailVerified: input.emailVerified,
      roles: input.roles ?? ["user"],
      permissionRefs: input.permissionRefs ?? [],
      clientInstanceId: String(this.options.clientInstanceId),
      authSource: this.options.authSource ?? "session-token",
      iss: this.options.issuer,
      iat: issuedAt,
      exp: expiresAt,
      correlationId: input.correlationId
    };

    return {
      chatSessionToken: signClaims(claims, this.options.secret),
      expiresAt: new Date(expiresAt * 1000).toISOString()
    };
  }
}

export class HmacSessionTokenAuthAdapter implements AuthAdapter {
  readonly id = "session-token";
  private readonly options: HmacSessionTokenOptions;

  constructor(options: HmacSessionTokenOptions) {
    this.options = options;
  }

  async authenticate(request: AuthRequest): Promise<AuthenticatedUser> {
    const token = extractBearerToken(request.headers);
    if (!token) {
      throw new AppError("UNAUTHENTICATED", "Missing bearer token");
    }

    const claims = verifyClaims(token, this.options.secret);
    if (claims.iss !== this.options.issuer) {
      throw new AppError("UNAUTHENTICATED", "Invalid token issuer");
    }
    if (claims.clientInstanceId !== String(this.options.clientInstanceId)) {
      throw new AppError("FORBIDDEN", "Token was issued for another client instance");
    }
    if (claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new AppError("UNAUTHENTICATED", "Chat session token is expired");
    }

    return {
      id: `${claims.clientInstanceId}:${claims.sub}`,
      externalUserId: claims.sub,
      displayLabel: claims.displayLabel,
      email: claims.email,
      emailVerified: claims.emailVerified,
      roles: claims.roles,
      permissionRefs: claims.permissionRefs,
      clientInstanceId: asClientInstanceId(claims.clientInstanceId),
      authSource: claims.authSource,
      correlationId: claims.correlationId ?? request.correlationId
    };
  }
}

function extractBearerToken(headers: AuthRequestHeaders): string | undefined {
  const authorization = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value?.startsWith("Bearer ")) {
    return undefined;
  }
  return value.slice("Bearer ".length).trim();
}

function signClaims(claims: SessionTokenClaims, secret: string): string {
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signature = createSignature(payload, secret);
  return `${payload}.${signature}`;
}

function verifyClaims(token: string, secret: string): SessionTokenClaims {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    throw new AppError("UNAUTHENTICATED", "Malformed chat session token");
  }

  const expected = createSignature(payload, secret);
  if (!safeEqual(signature, expected)) {
    throw new AppError("UNAUTHENTICATED", "Invalid chat session token signature");
  }

  const claims = JSON.parse(decodeBase64Url(payload)) as SessionTokenClaims;
  if (!claims.sub || !claims.displayLabel || !claims.clientInstanceId) {
    throw new AppError("UNAUTHENTICATED", "Malformed chat session token claims");
  }
  return claims;
}

function createSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
