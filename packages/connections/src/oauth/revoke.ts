import { connectionCallReasonOf } from "@work-shape/catalyst-core";
import type { OAuthFetch } from "./fetch";
import type { OAuthClient, OAuthServerMetadata, OAuthTokenTypeHint } from "./port";

// Token revocation (RFC 7009), written here because the MCP SDK has none. It is best effort:
// the caller has deleted the token on its side already, and the answer only says whether the
// provider confirmed. Nothing of the server's answer is read but its status.

/** How the client authenticates at the revocation endpoint, as RFC 7009 section 2.1 asks. */
function authMethodOf(server: OAuthServerMetadata, client: OAuthClient): string {
  if (client.clientSecret === undefined) return "none";
  const supported =
    server.revocationEndpointAuthMethodsSupported.length > 0
      ? server.revocationEndpointAuthMethodsSupported
      : server.tokenEndpointAuthMethodsSupported;
  if (supported.length === 0 || supported.includes("client_secret_basic")) {
    return "client_secret_basic";
  }
  return supported.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
}

/** The `Authorization` value of HTTP Basic for a client, each part form-encoded (RFC 6749 2.3.1). */
function basic(clientId: string, clientSecret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/gu, "+");
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`, "utf8").toString("base64")}`;
}

export async function revokeToken(input: {
  server: OAuthServerMetadata;
  client: OAuthClient;
  token: string;
  tokenTypeHint: OAuthTokenTypeHint;
  fetch: OAuthFetch;
}): Promise<"confirmed" | "failed" | "not_offered"> {
  const { server, client } = input;
  if (server.revocationEndpoint === undefined) return "not_offered";
  const body = new URLSearchParams({ token: input.token, token_type_hint: input.tokenTypeHint });
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json"
  });
  const method = authMethodOf(server, client);
  if (method === "client_secret_basic" && client.clientSecret !== undefined) {
    headers.set("authorization", basic(client.clientId, client.clientSecret));
  } else {
    body.set("client_id", client.clientId);
    if (method === "client_secret_post" && client.clientSecret !== undefined) {
      body.set("client_secret", client.clientSecret);
    }
  }
  try {
    const response = await input.fetch(server.revocationEndpoint, {
      method: "POST",
      headers,
      body
    });
    await response.body?.cancel();
    // RFC 7009 2.2: 200 whether or not the token was valid.
    return response.status === 200 ? "confirmed" : "failed";
  } catch (error) {
    // A refusal of the platform's own, such as a host off the egress list, is the caller's to
    // tell; every other failure is the provider's and only `failed`.
    if (connectionCallReasonOf(error) === "egress_denied") throw error;
    return "failed";
  } finally {
    body.delete("token");
  }
}
