import { connectionCallError, connectionOAuthError } from "@work-shape/catalyst-core";
import { issuersMatch, serverEndpointsOutside } from "./checks";
import type { OAuthFetch } from "./fetch";
import { OAuthPortError, type OAuthPort, type OAuthServerMetadata } from "./port";

// The authorization server of a Connection, as every step reads it: the start, the callback,
// a refresh and a revocation. Its metadata is untrusted; what it may name is checked here.

/**
 * Whether the browser may be sent to an authorization endpoint: an `https` address, or plain
 * `http` on the person's own machine, as a local server under test is. The browser carries
 * the state and, back, the code, so neither travels in the clear to another host.
 */
function browserSafe(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  const host = url.hostname;
  return (
    url.protocol === "http:" &&
    (host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/u.test(host))
  );
}

/** A failure of the port as the reason the flow tells. */
export function portFailure(
  error: unknown,
  reason: "oauth_discovery_failed" | "oauth_denied"
): unknown {
  if (error instanceof OAuthPortError) {
    if (error.failure === "invalid_answer") return connectionCallError("upstream_error");
    return connectionOAuthError(reason);
  }
  return error;
}

/**
 * The authorization server's metadata, refused unless it is the issuer asked, offers S256 and
 * the authorization code, sends the browser to a safe address, and keeps every endpoint the
 * instance sends a code, a token or client data to on the Connection's origin or the
 * issuer's.
 */
export async function checkedServer(input: {
  port: OAuthPort;
  issuer: string;
  /** The origin of the Connection's server: scheme, host and port. */
  connectionOrigin: string;
  fetch: OAuthFetch;
}): Promise<OAuthServerMetadata> {
  const { port, issuer, fetch } = input;
  let server: OAuthServerMetadata;
  try {
    server = await port.discoverServer({ issuer, fetch });
  } catch (error) {
    throw portFailure(error, "oauth_discovery_failed");
  }
  if (!issuersMatch(server.issuer, issuer)) throw connectionOAuthError("oauth_issuer_mismatch");
  if (!server.codeChallengeMethodsSupported.includes("S256")) {
    throw connectionOAuthError("oauth_pkce_unsupported");
  }
  if (!browserSafe(server.authorizationEndpoint)) {
    throw connectionOAuthError(
      "oauth_discovery_failed",
      "the authorization endpoint is no https address"
    );
  }
  if (!server.responseTypesSupported.includes("code")) {
    throw connectionOAuthError(
      "oauth_discovery_failed",
      "the authorization server offers no authorization code"
    );
  }
  if (serverEndpointsOutside(server, [input.connectionOrigin, issuer]) !== undefined) {
    throw connectionOAuthError(
      "oauth_discovery_failed",
      "the authorization server names a token, registration or revocation endpoint on another host than its own or the Connection's"
    );
  }
  return server;
}
