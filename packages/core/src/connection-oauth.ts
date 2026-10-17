import type { AppErrorCode, ConnectionOAuthRegistration } from "@work-shape/catalyst-asset-schemas";
import { AppError, isAppError } from "./errors";

export type { ConnectionOAuthRegistration };

// The OAuth sign-in of a Connection (CS-4b): why a start or a callback is refused, and the
// fixed places of the flow. The flow itself is in `connections/src/oauth/`.

/**
 * Why a start or a callback of a sign-in is refused, each with the error code it travels
 * under. The reason is the `details.reason` of the `AppError` and the first word of its
 * message. A callback carries it to the in-app page as `signIn=<reason>`.
 */
export const CONNECTION_OAUTH_REASONS = {
  /** No protected resource metadata, or no authorization server metadata, could be read. */
  oauth_discovery_failed: "CONFLICT",
  /** The authorization server does not list `S256` in `code_challenge_methods_supported`. */
  oauth_pkce_unsupported: "CONFLICT",
  /** The authorization server refused the registration, or answered other redirect URIs. */
  oauth_registration_refused: "CONFLICT",
  /**
   * The authorization server offers no registration and the Connection names no client id:
   * an administrator enters the client id the provider issued.
   */
  oauth_client_required: "CONFLICT",
  /** The state names no sign-in under way, or one another person started. */
  oauth_state_invalid: "FORBIDDEN",
  /** The sign-in took longer than a setup session lives. */
  oauth_session_expired: "CONFLICT",
  /** The person declined at the provider, or the provider refused the sign-in. */
  oauth_denied: "CONFLICT",
  /** The release config has no `instance.publicUrl`, so there is no redirect URI. */
  oauth_redirect_unconfigured: "CONFLICT",
  /** An issuer differs from the authorization server that was asked. */
  oauth_issuer_mismatch: "CONFLICT",
  /** The caller is no person signed in to the instance in a browser. */
  oauth_requires_person: "FORBIDDEN",
  /** The Connection was changed between the start and the callback. */
  oauth_connection_changed: "CONFLICT"
} as const satisfies Record<string, AppErrorCode>;

export type ConnectionOAuthReason = keyof typeof CONNECTION_OAUTH_REASONS;

const CONNECTION_OAUTH_MESSAGES: Record<ConnectionOAuthReason, string> = {
  oauth_discovery_failed: "the server's sign-in metadata could not be read",
  oauth_pkce_unsupported:
    "the authorization server does not offer PKCE with S256, so it cannot be connected safely",
  oauth_registration_refused: "the authorization server refused the registration of the client",
  oauth_client_required:
    "the authorization server registers no clients: enter the client id it issued in the Connection's settings",
  oauth_state_invalid: "the sign-in is unknown or was started by someone else",
  oauth_session_expired: "the sign-in took too long; start it again",
  oauth_denied: "the sign-in was declined at the provider",
  oauth_redirect_unconfigured:
    "the release config sets no 'instance.publicUrl', so the provider has no address to return to",
  oauth_issuer_mismatch: "the authorization server answered for another issuer",
  oauth_requires_person: "only a person signed in to the instance in a browser can connect",
  oauth_connection_changed:
    "the Connection was changed while the sign-in was under way; start it again"
};

/**
 * The error of a refused sign-in. `message` is a sentence of the platform's own code, never
 * text an outside system sent.
 */
export function connectionOAuthError(reason: ConnectionOAuthReason, message?: string): AppError {
  return new AppError(
    CONNECTION_OAUTH_REASONS[reason],
    `${reason}: ${message ?? CONNECTION_OAUTH_MESSAGES[reason]}`,
    { reason }
  );
}

export function isConnectionOAuthReason(value: unknown): value is ConnectionOAuthReason {
  return typeof value === "string" && Object.hasOwn(CONNECTION_OAUTH_REASONS, value);
}

/** The reason of a refused sign-in, or nothing for any other error. */
export function connectionOAuthReasonOf(error: unknown): ConnectionOAuthReason | undefined {
  if (!isAppError(error)) return undefined;
  const { details } = error;
  if (typeof details !== "object" || details === null || !("reason" in details)) return undefined;
  return isConnectionOAuthReason(details.reason) ? details.reason : undefined;
}

/**
 * Where the provider sends the browser back to for one Connection, under `instance.publicUrl`.
 * Each Connection has its own: a code one authorization server sent can only land at the
 * Connection whose client asked for it, also where the server sends no `iss` (RFC 9207).
 */
export function connectionOAuthCallbackPath(connectionName: string): string {
  return `/api/v1/connections/${encodeURIComponent(connectionName)}/oauth/callback`;
}

/** Whether a path is the callback of some Connection's sign-in, which holds a code and a state. */
export function isConnectionOAuthCallbackPath(path: string): boolean {
  return /^\/api\/v1\/connections\/[^/]+\/oauth\/callback\/?$/u.test(path);
}

/**
 * The one in-app page a callback redirects to, under `instance.publicUrl`. Its query holds
 * `signIn` (`connected` or a reason) and, where known, `connection` (the name), never a code,
 * a state or a token.
 */
export const CONNECTION_OAUTH_LANDING_PATH = "/build/connections";

/** The value of `signIn` on the landing page after a completed sign-in. */
export const CONNECTION_OAUTH_CONNECTED = "connected";

/** How long a sign-in may take from its start to its callback. */
export const CONNECTION_OAUTH_SESSION_TTL_MS = 15 * 60_000;

/** The registered OAuth client of a Connection, as `connection_state.oauth_client` holds it. */
export interface ConnectionOAuthClientState {
  /** The issuer of the authorization server the client was registered at. */
  issuer: string;
  clientId: string;
  /** The token endpoint auth method the registration answered. */
  method: string;
  registeredAt: string;
  /** The Connection's origin and the redirect URI the client was registered for. */
  origin: string;
  redirectUri: string;
}
