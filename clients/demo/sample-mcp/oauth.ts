import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// A small OAuth 2.1 authorization server in front of the sample MCP tools, so that a shared
// OAuth sign-in (CS-4b) can be tried and tested without an outside provider. Two modes, each
// its own protected resource and its own issuer:
//
// - `dcr`: a client registers itself by Dynamic Client Registration (RFC 7591).
// - `registered`: the client is the one the provider issued, named in the options.
//
// What it insists on is what a real provider insists on: PKCE with S256, the exact redirect
// URI of the client, a `resource` (RFC 8707) equal to the resource that was asked, codes used
// once and soon. It signs in one fixed demo account without a page to click: the request that
// reaches the authorization endpoint is answered with the redirect at once. Everything is held
// in memory and gone with the process.

/** The modes, each served under its own path. */
export const SAMPLE_OAUTH_MODES = ["dcr", "registered"] as const;
export type SampleOAuthMode = (typeof SAMPLE_OAUTH_MODES)[number];

/** The one scope the sample tools need. */
export const SAMPLE_OAUTH_SCOPE = "sample.read";

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_SECONDS = 3600;
const MAXIMUM_FORM_BYTES = 64 * 1024;
const MAXIMUM_CLIENTS = 1000;

export interface SampleOAuthOptions {
  /**
   * The address the platform reaches this server at, such as `http://sample-mcp:8787`. The
   * resources, the issuers and every endpoint the platform calls are under it.
   */
  issuerBase: string;
  /**
   * The address a browser reaches this server at, for the authorization endpoint. Left out,
   * the issuer base. In Compose the API reaches `sample-mcp`, the browser `localhost`.
   */
  browserBase?: string;
  /** The client of the mode `registered`, as a provider issues one. */
  registeredClient?: { clientId: string; clientSecret?: string; redirectUri: string };
  /** Changes what the metadata says. For tests of a provider that says something else. */
  adjustMetadata?: (
    mode: SampleOAuthMode,
    kind: "resource" | "server",
    metadata: Record<string, unknown>
  ) => Record<string, unknown>;
  /** Changes what a registration answers. For tests. */
  adjustRegistration?: (answer: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Sees each value that must stay secret as it is issued or received: a code, a verifier, a
   * token. For tests that look for them where they must not be.
   */
  onSecret?: (value: string) => void;
}

interface Client {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}

interface Grant {
  mode: SampleOAuthMode;
  clientId: string;
  resource: string;
  scope: string;
}

interface PendingCode extends Grant {
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}

/** One line of what happened, never a token, a code, a state or a secret. */
export type SampleOAuthLog = (line: string) => void;

class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string
  ) {
    super(error);
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function opaque(): string {
  return randomBytes(32).toString("base64url");
}

function digestOf(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameSecret(left: string, right: string): boolean {
  return timingSafeEqual(digestOf(left), digestOf(right));
}

function readText(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) return;
      size += chunk.length;
      if (size > MAXIMUM_FORM_BYTES) {
        reject(new OAuthError(413, "invalid_request"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", () => reject(new OAuthError(400, "invalid_request")));
  });
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const type = request.headers["content-type"] ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    throw new OAuthError(400, "invalid_request");
  }
  return new URLSearchParams(await readText(request));
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readText(request));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value));
    }
  } catch {
    // Answered below.
  }
  throw new OAuthError(400, "invalid_client_metadata");
}

/** The client id and secret of HTTP Basic, each part form-decoded (RFC 6749 2.3.1). */
function basicCredentials(header: string | undefined): { id: string; secret: string } | undefined {
  const encoded = /^Basic ([A-Za-z0-9+/=]+)$/u.exec(header ?? "")?.[1];
  if (encoded === undefined) return undefined;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return undefined;
  const decode = (value: string) => decodeURIComponent(value.replaceAll("+", " "));
  return { id: decode(decoded.slice(0, colon)), secret: decode(decoded.slice(colon + 1)) };
}

export function createSampleOAuth(options: SampleOAuthOptions, log?: SampleOAuthLog) {
  const issuerBase = new URL(options.issuerBase).origin;
  const browserBase = new URL(options.browserBase ?? options.issuerBase).origin;
  const clients = new Map<string, Client>();
  const codes = new Map<string, PendingCode>();
  const accessTokens = new Map<string, Grant & { expiresAt: number }>();
  const refreshTokens = new Map<string, Grant>();
  if (options.registeredClient) {
    clients.set(options.registeredClient.clientId, {
      clientId: options.registeredClient.clientId,
      ...(options.registeredClient.clientSecret === undefined
        ? {}
        : { clientSecret: options.registeredClient.clientSecret }),
      redirectUris: [options.registeredClient.redirectUri]
    });
  }

  const resourceOf = (mode: SampleOAuthMode) => `${issuerBase}/${mode}/mcp`;
  const issuerOf = (mode: SampleOAuthMode) => `${issuerBase}/${mode}`;
  const resourceMetadataUrlOf = (mode: SampleOAuthMode) =>
    `${issuerBase}/.well-known/oauth-protected-resource/${mode}/mcp`;

  function resourceMetadata(mode: SampleOAuthMode): Record<string, unknown> {
    const metadata = {
      resource: resourceOf(mode),
      authorization_servers: [issuerOf(mode)],
      scopes_supported: [SAMPLE_OAUTH_SCOPE],
      bearer_methods_supported: ["header"]
    };
    return options.adjustMetadata?.(mode, "resource", metadata) ?? metadata;
  }

  function serverMetadata(mode: SampleOAuthMode): Record<string, unknown> {
    const issuer = issuerOf(mode);
    const metadata = {
      issuer,
      authorization_endpoint: `${browserBase}/${mode}/authorize`,
      token_endpoint: `${issuer}/token`,
      revocation_endpoint: `${issuer}/revoke`,
      ...(mode === "dcr" ? { registration_endpoint: `${issuer}/register` } : {}),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported:
        mode === "dcr" ? ["none"] : ["client_secret_basic", "client_secret_post", "none"],
      scopes_supported: [SAMPLE_OAUTH_SCOPE],
      authorization_response_iss_parameter_supported: true
    };
    return options.adjustMetadata?.(mode, "server", metadata) ?? metadata;
  }

  /** The client a token or revocation request authenticates as, or a refusal. */
  function authenticateClient(request: IncomingMessage, form: URLSearchParams): Client {
    const basic = basicCredentials(request.headers.authorization);
    const clientId = basic?.id ?? form.get("client_id") ?? "";
    const client = clients.get(clientId);
    if (!client) throw new OAuthError(401, "invalid_client");
    if (client.clientSecret !== undefined) {
      const presented = basic?.secret ?? form.get("client_secret") ?? "";
      if (!sameSecret(presented, client.clientSecret)) throw new OAuthError(401, "invalid_client");
    }
    return client;
  }

  function authorize(mode: SampleOAuthMode, url: URL, response: ServerResponse): void {
    const query = url.searchParams;
    const client = clients.get(query.get("client_id") ?? "");
    const redirectUri = query.get("redirect_uri") ?? "";
    // Without a known client and its exact redirect URI the browser is sent nowhere.
    if (!client || !client.redirectUris.includes(redirectUri)) {
      throw new OAuthError(400, "invalid_request");
    }
    const back = new URL(redirectUri);
    const state = query.get("state");
    if (state !== null) back.searchParams.set("state", state);
    back.searchParams.set("iss", issuerOf(mode));
    const challenge = query.get("code_challenge") ?? "";
    const refusal =
      query.get("response_type") !== "code"
        ? "unsupported_response_type"
        : query.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)
          ? "invalid_request"
          : query.get("resource") !== resourceOf(mode)
            ? "invalid_target"
            : undefined;
    if (refusal !== undefined) {
      back.searchParams.set("error", refusal);
    } else {
      const code = opaque();
      options.onSecret?.(code);
      codes.set(code, {
        mode,
        clientId: client.clientId,
        redirectUri,
        challenge,
        resource: resourceOf(mode),
        scope: SAMPLE_OAUTH_SCOPE,
        expiresAt: Date.now() + CODE_TTL_MS
      });
      back.searchParams.set("code", code);
    }
    log?.(`GET /${mode}/authorize 302${refusal === undefined ? "" : ` ${refusal}`}`);
    response.writeHead(302, { Location: back.href, "Cache-Control": "no-store" });
    response.end();
  }

  function issue(grant: Grant): Record<string, unknown> {
    const accessToken = opaque();
    const refreshToken = opaque();
    options.onSecret?.(accessToken);
    options.onSecret?.(refreshToken);
    accessTokens.set(accessToken, { ...grant, expiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000 });
    refreshTokens.set(refreshToken, grant);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: grant.scope
    };
  }

  async function token(mode: SampleOAuthMode, request: IncomingMessage): Promise<unknown> {
    const form = await readForm(request);
    const client = authenticateClient(request, form);
    if (form.get("resource") !== resourceOf(mode)) throw new OAuthError(400, "invalid_target");
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const pending = codes.get(code);
      // A code is used once, whatever comes of it.
      codes.delete(code);
      const verifier = form.get("code_verifier") ?? "";
      if (verifier.length > 0) options.onSecret?.(verifier);
      if (
        !pending ||
        pending.mode !== mode ||
        pending.expiresAt < Date.now() ||
        pending.clientId !== client.clientId ||
        pending.redirectUri !== form.get("redirect_uri") ||
        createHash("sha256").update(verifier, "ascii").digest("base64url") !== pending.challenge
      ) {
        throw new OAuthError(400, "invalid_grant");
      }
      return issue(pending);
    }
    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token") ?? "";
      const grant = refreshTokens.get(refreshToken);
      refreshTokens.delete(refreshToken);
      if (!grant || grant.mode !== mode || grant.clientId !== client.clientId) {
        throw new OAuthError(400, "invalid_grant");
      }
      return issue(grant);
    }
    throw new OAuthError(400, "unsupported_grant_type");
  }

  async function register(request: IncomingMessage): Promise<unknown> {
    const metadata = await readJsonObject(request);
    const redirectUris = metadata.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every((uri): uri is string => typeof uri === "string" && URL.canParse(uri))
    ) {
      throw new OAuthError(400, "invalid_redirect_uri");
    }
    if (clients.size >= MAXIMUM_CLIENTS) throw new OAuthError(400, "invalid_client_metadata");
    const clientId = `sample-${randomBytes(8).toString("hex")}`;
    clients.set(clientId, { clientId, redirectUris });
    const answer = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    };
    return options.adjustRegistration?.(answer) ?? answer;
  }

  async function revoke(request: IncomingMessage): Promise<void> {
    const form = await readForm(request);
    const client = authenticateClient(request, form);
    const value = form.get("token") ?? "";
    for (const tokens of [accessTokens, refreshTokens]) {
      if (tokens.get(value)?.clientId === client.clientId) tokens.delete(value);
    }
  }

  return {
    /** The resource address of a mode, the address a Connection names. */
    resourceOf,
    /** The value of `WWW-Authenticate` that a request of a mode without a valid token gets. */
    challengeOf: (mode: SampleOAuthMode) =>
      `Bearer resource_metadata="${resourceMetadataUrlOf(mode)}", scope="${SAMPLE_OAUTH_SCOPE}"`,
    /** Whether a bearer token is one this server issued for the mode's resource. */
    accepts(mode: SampleOAuthMode, bearer: string | undefined): boolean {
      if (bearer === undefined) return false;
      const grant = accessTokens.get(bearer);
      return grant !== undefined && grant.mode === mode && grant.expiresAt > Date.now();
    },
    /** How many tokens are live, for tests of a revocation. */
    liveTokenCount: () => accessTokens.size + refreshTokens.size,
    /**
     * Answers a request this server serves and says so; leaves every other one.
     * The MCP endpoints of the modes stay with the caller.
     */
    async handle(request: IncomingMessage, response: ServerResponse, path: string) {
      const url = new URL(request.url ?? "/", issuerBase);
      for (const mode of SAMPLE_OAUTH_MODES) {
        const route = `${request.method ?? ""} ${path}`;
        try {
          if (route === `GET /.well-known/oauth-protected-resource/${mode}/mcp`) {
            json(response, 200, resourceMetadata(mode));
          } else if (route === `GET /.well-known/oauth-authorization-server/${mode}`) {
            json(response, 200, serverMetadata(mode));
          } else if (route === `GET /${mode}/authorize`) {
            authorize(mode, url, response);
          } else if (route === `POST /${mode}/token`) {
            json(response, 200, await token(mode, request));
            log?.(`POST /${mode}/token 200`);
          } else if (route === `POST /${mode}/register` && mode === "dcr") {
            json(response, 201, await register(request));
            log?.(`POST /${mode}/register 201`);
          } else if (route === `POST /${mode}/revoke`) {
            await revoke(request);
            response.writeHead(200).end();
            log?.(`POST /${mode}/revoke 200`);
          } else {
            continue;
          }
        } catch (error) {
          if (!(error instanceof OAuthError)) throw error;
          log?.(`${route} ${error.status} ${error.error}`);
          json(response, error.status, { error: error.error });
        }
        return true;
      }
      return false;
    }
  };
}
