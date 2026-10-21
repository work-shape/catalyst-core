import type { OAuthFetch } from "./fetch";

// The product-owned port of the OAuth flow of a Connection: discovery, registration, the
// authorization address, code exchange, refresh and revocation. Its types are the platform's
// own; the first adapter wraps the MCP SDK's standalone auth functions and keeps the SDK's
// types inside it. Every function is handed the `fetch` of its step, so every request passes
// the egress check, the pin and the byte cap.

/** Protected resource metadata (RFC 9728), as far as the flow reads it. Untrusted. */
/** Which token a revocation names (RFC 7009 section 2.1). */
export type OAuthTokenTypeHint = "refresh_token" | "access_token";

export interface OAuthResourceMetadata {
  /** The `resource` value, sent as it was written as RFC 8707's `resource`. */
  resource: string;
  authorizationServers: readonly string[];
  scopesSupported?: readonly string[];
}

/** Authorization server metadata (RFC 8414 or OpenID discovery), as the flow reads it. */
export interface OAuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  responseTypesSupported: readonly string[];
  /** Empty where the metadata names none. */
  codeChallengeMethodsSupported: readonly string[];
  /** Empty where the metadata names none. */
  tokenEndpointAuthMethodsSupported: readonly string[];
  revocationEndpointAuthMethodsSupported: readonly string[];
  /** RFC 9207: the server puts `iss` into its authorization answer. */
  authorizationResponseIssParameterSupported: boolean;
}

/** An OAuth client of the instance at one authorization server. */
export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  /** The token endpoint auth method a registration answered. */
  tokenEndpointAuthMethod?: string;
}

/** A registration's answer: the client and the redirect URIs the server stored for it. */
export interface OAuthRegisteredClient extends OAuthClient {
  redirectUris: readonly string[];
}

/** A token endpoint's answer. Lives in memory until it is sealed into the Secret Store. */
export interface OAuthTokenSet {
  accessToken: string;
  tokenType: string;
  /** Seconds, as the server answered. */
  expiresIn?: number;
  refreshToken?: string;
  /** The granted scope, as the server answered it. */
  scope?: string;
}

/** Why a step of the port failed. Never text of the server. */
export type OAuthPortFailure =
  | "no_resource_metadata"
  | "no_server_metadata"
  | "registration_refused"
  | "token_refused"
  /** The token endpoint refused a refresh with `invalid_grant`: the grant is gone. */
  | "invalid_grant"
  /** The token endpoint refused the client itself with `invalid_client`. */
  | "invalid_client"
  | "invalid_answer";

/** The failure of a step of the port. It carries its kind, never a server's text. */
export class OAuthPortError extends Error {
  readonly failure: OAuthPortFailure;
  constructor(failure: OAuthPortFailure) {
    super(`The OAuth step failed: ${failure}`);
    this.name = "OAuthPortError";
    this.failure = failure;
  }
}

export interface OAuthPort {
  /**
   * The protected resource metadata of `resourceUrl`: at `resourceMetadataUrl` where the
   * challenge named one, else at the path well-known, else at the root well-known.
   */
  discoverResource(input: {
    resourceUrl: string;
    resourceMetadataUrl?: string;
    fetch: OAuthFetch;
  }): Promise<OAuthResourceMetadata>;
  /** The metadata of the authorization server `issuer`, in the MCP specification's order. */
  discoverServer(input: { issuer: string; fetch: OAuthFetch }): Promise<OAuthServerMetadata>;
  /** Registers a client by Dynamic Client Registration (RFC 7591). */
  register(input: {
    server: OAuthServerMetadata;
    clientName: string;
    redirectUri: string;
    scope?: string;
    fetch: OAuthFetch;
  }): Promise<OAuthRegisteredClient>;
  /** The authorization address with PKCE (S256), and the verifier that belongs to it. */
  authorizationUrl(input: {
    server: OAuthServerMetadata;
    client: OAuthClient;
    redirectUri: string;
    scope?: string;
    state: string;
    /** RFC 8707's `resource`. Left out for a server the settings name, which may refuse it. */
    resource?: string;
  }): Promise<{ url: string; codeVerifier: string }>;
  exchange(input: {
    server: OAuthServerMetadata;
    client: OAuthClient;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    resource?: string;
    fetch: OAuthFetch;
  }): Promise<OAuthTokenSet>;
  /**
   * Refreshes the access token. A refusal of the grant fails with `invalid_grant` or
   * `invalid_client`; every other failure, such as a server error or no answer, with
   * `token_refused`, which a later refresh may get past.
   */
  refresh(input: {
    server: OAuthServerMetadata;
    client: OAuthClient;
    refreshToken: string;
    resource?: string;
    fetch: OAuthFetch;
  }): Promise<OAuthTokenSet>;
  /**
   * Revokes a token (RFC 7009). Answers whether the server confirmed; a server without a
   * revocation endpoint answers `not_offered` and is sent nothing.
   */
  revoke(input: {
    server: OAuthServerMetadata;
    client: OAuthClient;
    token: string;
    tokenTypeHint: OAuthTokenTypeHint;
    fetch: OAuthFetch;
  }): Promise<"confirmed" | "failed" | "not_offered">;
}
