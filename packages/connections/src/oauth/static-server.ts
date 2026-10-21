import {
  connectionOAuthError,
  type ConnectorOAuthEndpoints,
  type ConnectorTypeDefinition,
  type JsonObject
} from "@work-shape/catalyst-core";
import type { OAuthFetch } from "./fetch";
import type { OAuthPort, OAuthServerMetadata } from "./port";
import { checkedServer } from "./server";

// The authorization server a Connection names in its own settings (CONN-OAUTH-1), as every
// step of the flow reads one: the start, the callback, a refresh and a revocation. Nothing is
// discovered and nothing registered. The settings were checked at the save: every address is
// `https` (or `http` on the machine itself), and the client secret and the sign-in are bound to
// these full addresses, the issuer and the client id, so a change of them ends both.

/**
 * The name a setup session and a token set keep for such a server: the issuer the settings
 * name, else the token address. A refresh or revocation for another one is refused.
 */
function staticIssuerOf(endpoints: ConnectorOAuthEndpoints): string {
  return endpoints.issuer ?? endpoints.tokenUrl;
}

/** The server as the port reads one: authorization code with S256, the client's auth method. */
export function staticServerOf(endpoints: ConnectorOAuthEndpoints): OAuthServerMetadata {
  return {
    issuer: staticIssuerOf(endpoints),
    authorizationEndpoint: endpoints.authorizationUrl ?? endpoints.tokenUrl,
    tokenEndpoint: endpoints.tokenUrl,
    ...(endpoints.revocationUrl === undefined
      ? {}
      : { revocationEndpoint: endpoints.revocationUrl }),
    responseTypesSupported: ["code"],
    codeChallengeMethodsSupported: ["S256"],
    tokenEndpointAuthMethodsSupported: [endpoints.tokenAuthMethod],
    revocationEndpointAuthMethodsSupported: [endpoints.tokenAuthMethod],
    authorizationResponseIssParameterSupported: false
  };
}

/** The authorization server of a Connection's sign-in, at one step after its start. */
export interface SignInServer {
  server: OAuthServerMetadata;
  /**
   * The settings name the server: no RFC 8707 `resource` is sent, since some providers refuse
   * it (Microsoft's v2 endpoints), and `iss` is compared only with an issuer the settings name.
   */
  endpoints?: ConnectorOAuthEndpoints;
}

/**
 * The server a sign-in made at `issuer` reaches for its next step: the one the settings name,
 * which must be that issuer, or the discovered one, checked as at the start.
 */
export async function signInServerOf(input: {
  port: OAuthPort;
  type: ConnectorTypeDefinition;
  settings: JsonObject;
  issuer: string;
  /** The origin of the Connection's server, for a discovered one. */
  connectionOrigin: string;
  fetch: OAuthFetch;
}): Promise<SignInServer> {
  const endpoints = input.type.oauthEndpoints?.(input.settings);
  if (endpoints !== undefined) {
    if (staticIssuerOf(endpoints) !== input.issuer) {
      throw connectionOAuthError("oauth_connection_changed");
    }
    return { server: staticServerOf(endpoints), endpoints };
  }
  return {
    server: await checkedServer({
      port: input.port,
      issuer: input.issuer,
      connectionOrigin: input.connectionOrigin,
      fetch: input.fetch
    })
  };
}

/** The authorization address with the settings' fixed extra parameters added. */
export function withAuthorizationParams(
  address: string,
  endpoints: ConnectorOAuthEndpoints | undefined
): string {
  if (endpoints === undefined) return address;
  const url = new URL(address);
  for (const [name, value] of Object.entries(endpoints.authorizationParams)) {
    // The settings refuse a protocol parameter; one that is set all the same stays as it is.
    if (!url.searchParams.has(name)) url.searchParams.set(name, value);
  }
  return url.href;
}
