import {
  AppError,
  SHARED_CREDENTIAL_SUBJECT,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type ConnectionConfig,
  type JsonObject
} from "@work-shape/catalyst-core";

/** The only subject selector for a call. No caller-supplied subject reaches this boundary. */
export function credentialSubject(
  config: Pick<ConnectionConfig, "credentialMode">,
  actor: AuthenticatedIdentity | undefined
): string {
  if (config.credentialMode === "shared") return SHARED_CREDENTIAL_SUBJECT;
  if (!actor || isAuthenticatedServicePrincipal(actor)) {
    throw new AppError(
      "CONFLICT",
      "connection_not_connected: connect under Settings > You > Verbindungen",
      {
        reason: "connection_not_connected"
      }
    );
  }
  return `user:${actor.id}`;
}

/** Account display is deliberately absent from governance records. */
export function bindingAuditSubject(subject: string): JsonObject {
  return subject.startsWith("user:")
    ? { subjectKind: "user", userId: subject.slice(5) }
    : { subjectKind: SHARED_CREDENTIAL_SUBJECT };
}

/** Only the two display claims, and only following an OpenID request; never used as identity. */
export function accountLabel(
  idToken: string | undefined,
  scopes: readonly string[]
): string | undefined {
  if (!scopes.includes("openid") || !idToken || idToken.length > 32_768) return undefined;
  try {
    const pieces = idToken.split(".");
    const payload = pieces[1];
    if (pieces.length !== 3 || payload === undefined) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims !== "object" || claims === null) return undefined;
    const value =
      "email" in claims && typeof claims.email === "string"
        ? claims.email
        : "preferred_username" in claims && typeof claims.preferred_username === "string"
          ? claims.preferred_username
          : undefined;
    return value && value.length <= 320 && !/[\u0000-\u001f\u007f]/u.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
