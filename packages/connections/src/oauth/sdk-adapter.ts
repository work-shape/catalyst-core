import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InvalidClientError,
  InvalidGrantError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthProtectedResourceMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { connectionCallReasonOf } from "@work-shape/catalyst-core";
import type { OAuthFetch } from "./fetch";
import {
  OAuthPortError,
  type OAuthClient,
  type OAuthPort,
  type OAuthPortFailure,
  type OAuthResourceMetadata,
  type OAuthServerMetadata,
  type OAuthTokenSet
} from "./port";
import { revokeToken } from "./revoke";

// The first adapter of the OAuth port: the MCP SDK's standalone auth functions, each handed
// the step's checked fetch. The SDK's types stay in this file. An error of the SDK carries
// text of the server; it is replaced by one failure kind. A refusal of the platform's own,
// such as `egress_denied` from the fetch, leaves as it is.

/** The `MCP-Protocol-Version` the metadata requests name. */
const PROTOCOL_VERSION = "2025-11-25";

async function step<Result>(
  failure: OAuthPortFailure,
  work: () => Promise<Result>
): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (connectionCallReasonOf(error) !== undefined) throw error;
    throw new OAuthPortError(failure);
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function resourceOf(metadata: OAuthProtectedResourceMetadata): OAuthResourceMetadata {
  return {
    resource: metadata.resource,
    authorizationServers: metadata.authorization_servers ?? [],
    ...(metadata.scopes_supported === undefined
      ? {}
      : { scopesSupported: strings(metadata.scopes_supported) })
  };
}

/** A field of the metadata that not every variant of the SDK's type declares. */
function extraField(metadata: AuthorizationServerMetadata, key: string): unknown {
  const fields = new Map<string, unknown>(Object.entries(metadata));
  return fields.get(key);
}

function serverOf(metadata: AuthorizationServerMetadata): OAuthServerMetadata {
  const revocation = extraField(metadata, "revocation_endpoint");
  return {
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    ...(metadata.registration_endpoint === undefined
      ? {}
      : { registrationEndpoint: metadata.registration_endpoint }),
    ...(typeof revocation === "string" ? { revocationEndpoint: revocation } : {}),
    responseTypesSupported: strings(metadata.response_types_supported),
    codeChallengeMethodsSupported: strings(metadata.code_challenge_methods_supported),
    tokenEndpointAuthMethodsSupported: strings(metadata.token_endpoint_auth_methods_supported),
    revocationEndpointAuthMethodsSupported: strings(
      extraField(metadata, "revocation_endpoint_auth_methods_supported")
    ),
    authorizationResponseIssParameterSupported:
      extraField(metadata, "authorization_response_iss_parameter_supported") === true
  };
}

/** The SDK's view of a server the platform discovered: the fields its functions read. */
function sdkMetadata(server: OAuthServerMetadata): AuthorizationServerMetadata {
  return {
    issuer: server.issuer,
    authorization_endpoint: server.authorizationEndpoint,
    token_endpoint: server.tokenEndpoint,
    response_types_supported: [...server.responseTypesSupported],
    code_challenge_methods_supported: [...server.codeChallengeMethodsSupported],
    ...(server.tokenEndpointAuthMethodsSupported.length === 0
      ? {}
      : { token_endpoint_auth_methods_supported: [...server.tokenEndpointAuthMethodsSupported] }),
    ...(server.registrationEndpoint === undefined
      ? {}
      : { registration_endpoint: server.registrationEndpoint })
  };
}

function sdkClient(client: OAuthClient): OAuthClientInformationMixed {
  return {
    client_id: client.clientId,
    ...(client.clientSecret === undefined ? {} : { client_secret: client.clientSecret }),
    ...(client.tokenEndpointAuthMethod === undefined
      ? {}
      : { token_endpoint_auth_method: client.tokenEndpointAuthMethod, redirect_uris: [] })
  };
}

function tokenSetOf(tokens: OAuthTokens): OAuthTokenSet {
  return {
    accessToken: tokens.access_token,
    tokenType: tokens.token_type,
    ...(tokens.expires_in === undefined ? {} : { expiresIn: tokens.expires_in }),
    ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope })
  };
}

const fetchLike = (fetch: OAuthFetch) => (url: string | URL, init?: RequestInit) =>
  fetch(url, init);

/** The OAuth port over the MCP SDK's auth functions. */
export function createSdkOAuthPort(): OAuthPort {
  return {
    async discoverResource({ resourceUrl, resourceMetadataUrl, fetch }) {
      // The challenge's address first. Where it names none, or nothing is there, the
      // well-known places of the resource, path first and root second.
      if (resourceMetadataUrl !== undefined) {
        try {
          return resourceOf(
            await discoverOAuthProtectedResourceMetadata(
              resourceUrl,
              { protocolVersion: PROTOCOL_VERSION, resourceMetadataUrl },
              fetchLike(fetch)
            )
          );
        } catch (error) {
          if (connectionCallReasonOf(error) !== undefined) throw error;
        }
      }
      return step("no_resource_metadata", async () =>
        resourceOf(
          await discoverOAuthProtectedResourceMetadata(
            resourceUrl,
            { protocolVersion: PROTOCOL_VERSION },
            fetchLike(fetch)
          )
        )
      );
    },
    async discoverServer({ issuer, fetch }) {
      const metadata = await step("no_server_metadata", () =>
        discoverAuthorizationServerMetadata(issuer, {
          fetchFn: fetchLike(fetch),
          protocolVersion: PROTOCOL_VERSION
        })
      );
      if (metadata === undefined) throw new OAuthPortError("no_server_metadata");
      return serverOf(metadata);
    },
    async register({ server, clientName, redirectUri, scope, fetch }) {
      const registered = await step("registration_refused", () =>
        registerClient(server.issuer, {
          metadata: sdkMetadata(server),
          clientMetadata: {
            client_name: clientName,
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none"
          },
          ...(scope === undefined ? {} : { scope }),
          fetchFn: fetchLike(fetch)
        })
      );
      return {
        clientId: registered.client_id,
        ...(registered.client_secret === undefined
          ? {}
          : { clientSecret: registered.client_secret }),
        ...(registered.token_endpoint_auth_method === undefined
          ? {}
          : { tokenEndpointAuthMethod: registered.token_endpoint_auth_method }),
        redirectUris: registered.redirect_uris
      };
    },
    async authorizationUrl({ server, client, redirectUri, scope, state, resource }) {
      const started = await step("invalid_answer", () =>
        startAuthorization(server.issuer, {
          metadata: sdkMetadata(server),
          clientInformation: sdkClient(client),
          redirectUrl: redirectUri,
          ...(scope === undefined ? {} : { scope }),
          state,
          ...(resource === undefined ? {} : { resource })
        })
      );
      return { url: started.authorizationUrl.href, codeVerifier: started.codeVerifier };
    },
    async exchange({ server, client, code, codeVerifier, redirectUri, resource, fetch }) {
      const tokens = await step("token_refused", () =>
        exchangeAuthorization(server.issuer, {
          metadata: sdkMetadata(server),
          clientInformation: sdkClient(client),
          authorizationCode: code,
          codeVerifier,
          redirectUri,
          ...(resource === undefined ? {} : { resource }),
          fetchFn: fetchLike(fetch)
        })
      );
      return tokenSetOf(tokens);
    },
    async refresh({ server, client, refreshToken, resource, fetch }) {
      let tokens: OAuthTokens;
      try {
        tokens = await refreshAuthorization(server.issuer, {
          metadata: sdkMetadata(server),
          clientInformation: sdkClient(client),
          refreshToken,
          ...(resource === undefined ? {} : { resource }),
          fetchFn: fetchLike(fetch)
        });
      } catch (error) {
        if (connectionCallReasonOf(error) !== undefined) throw error;
        // Only the two refusals that say the grant or the client is gone end the sign-in.
        if (error instanceof InvalidGrantError) throw new OAuthPortError("invalid_grant");
        if (error instanceof InvalidClientError) throw new OAuthPortError("invalid_client");
        throw new OAuthPortError("token_refused");
      }
      return tokenSetOf(tokens);
    },
    revoke: (input) => revokeToken(input)
  };
}
