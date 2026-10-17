import { createServer, type Server } from "node:http";
import { z } from "zod";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import type { SampleOAuthOptions } from "@work-shape/catalyst-demo/sample-mcp";
import { createSampleMcpServer } from "@work-shape/catalyst-demo/sample-mcp";
import { createTestConfig } from "./fixtures";
import { generateSecretStoreKey, generateTestSecret } from "./test-connector";
import { createTestInstance, listenTestInstance, type TestInstance } from "./test-instance";
import { withTestSql } from "./test-sql";

// The world of the shared OAuth sign-in tests (CS-4b2): an assembled instance with real
// sign-in by password (so a request carries a first-party session), the demo's sample MCP
// server with its authorization server in front, and a trap server the egress list leaves
// out, which counts every request that reaches it.

/** The browser origin of the instance, `instance.publicUrl`. Nothing listens there. */
const PUBLIC_URL = "http://localhost:5173";
export const CALLBACK_PATH = "/api/v1/connections/oauth/callback";
export const REDIRECT_URI = `${PUBLIC_URL}${CALLBACK_PATH}`;
const LANDING = `${PUBLIC_URL}/build/connections`;
/** The client the provider issued for the Connection `registered`. */
export const REGISTERED_CLIENT_ID = "catalyst-registered";

const PEOPLE = {
  alice: "alice@example.test",
  bob: "bob@example.test"
} as const;
type Person = keyof typeof PEOPLE;

const signInAnswerSchema = z.object({ user: z.object({ id: z.string() }) });
const meSchema = z.object({ id: z.string() });
const tokenAnswerSchema = z.object({ chatSessionToken: z.string() });
const accessTokenSchema = z.object({ accessToken: z.string() });

interface TrapServer {
  readonly base: string;
  /** How many requests reached it. */
  readonly hits: () => number;
}

export interface OAuthWorld {
  readonly instance: TestInstance;
  /** The address the test reaches the instance at. */
  readonly api: string;
  /** The sample MCP server's base, as the instance reaches it. */
  readonly sample: string;
  readonly trap: TrapServer;
  /** Every code, verifier and token the authorization server issued or received. */
  readonly secrets: string[];
  /** The client secret of the Connection `registered`. */
  readonly clientSecret: string;
  /** What the sample's metadata and registration say. A test sets them and resets after. */
  readonly provider: {
    adjustMetadata?: SampleOAuthOptions["adjustMetadata"];
    adjustRegistration?: SampleOAuthOptions["adjustRegistration"];
  };
  /** A session token an embedding host had the instance issue for a user it names. */
  embeddedToken(): Promise<string>;
  /** An access token of a Service Principal's API key that may write config assets. */
  servicePrincipalToken(): Promise<string>;
  /**
   * The cookie header of a person's signed-in session: the one they signed in with first, or
   * with `again`, a new session of theirs. Sign-ins are counted, so a test reuses them.
   */
  signIn(person: Person, again?: "again"): Promise<string>;
  /** The platform user id of a person, by their session. */
  userIdOf(cookie: string): Promise<string>;
  /** `connections.oauth_start` in the person's browser session. */
  start(name: string, cookie: string): Promise<{ status: number; body: unknown }>;
  /** `connections.oauth_start` with a bearer token instead of a browser session. */
  startWithToken(name: string, token: string): Promise<number>;
  /** `connections.test` in the person's browser session: its status and its text. */
  test(name: string, cookie: string): Promise<{ status: number; text: string }>;
  /** `connections.get` in the person's browser session, as text. */
  detail(name: string, cookie: string): Promise<string>;
  /** `assets.put` of a runtime Connection in the person's browser session, at its revision. */
  putConnection(name: string, config: Record<string, unknown>, cookie: string): Promise<number>;
  /** Follows the authorization address to the provider; answers where it sends the browser. */
  authorize(authorizationUrl: string): Promise<URL>;
  /** The callback as the browser reaches it, with the given headers. */
  callback(
    providerRedirect: URL,
    headers?: Record<string, string>
  ): Promise<{ status: number; location: string | null; body: string }>;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function startTrap(): Promise<{ trap: TrapServer; close(): Promise<void> }> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(500).end();
  });
  const base = await listen(server);
  return {
    trap: { base, hits: () => hits },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

/** The cookie header of a sign-in's answer: every cookie's name and value. */
function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

export async function createOAuthWorld(): Promise<OAuthWorld> {
  const secrets: string[] = [];
  const provider: OAuthWorld["provider"] = {};
  const clientSecret = generateTestSecret();
  const passwords = { alice: generateTestSecret(), bob: generateTestSecret() };
  const serverCredential = generateTestSecret();
  const sessions = new Map<Person, string>();
  const trap = await startTrap();
  const samplePort = await reservePort();
  const sampleBase = `http://127.0.0.1:${samplePort}`;
  const sampleKey = generateTestSecret();
  const sample = createSampleMcpServer({
    key: sampleKey,
    oauth: {
      issuerBase: sampleBase,
      registeredClient: { clientId: REGISTERED_CLIENT_ID, clientSecret, redirectUri: REDIRECT_URI },
      adjustMetadata: (mode, kind, metadata) =>
        provider.adjustMetadata?.(mode, kind, metadata) ?? metadata,
      adjustRegistration: (answer) => provider.adjustRegistration?.(answer) ?? answer,
      onSecret: (value) => secrets.push(value)
    }
  });
  await sample.listen(samplePort, "127.0.0.1");

  const base = createTestConfig({ developmentAuth: { enabled: false } });
  const config = parseClientInstanceConfig({
    ...base,
    auth: {
      standalone: {
        enabled: true,
        trustedOrigins: [PUBLIC_URL],
        seedUsers: [
          {
            email: PEOPLE.alice,
            displayLabel: "Alice",
            passwordEnvName: "ALICE_PASSWORD",
            roles: ["user", "admin"]
          },
          {
            email: PEOPLE.bob,
            displayLabel: "Bob",
            passwordEnvName: "BOB_PASSWORD",
            roles: ["user", "admin"]
          }
        ]
      },
      sessionToken: { issuer: "embedding-host", ttlSeconds: 900 }
    },
    instance: { publicUrl: PUBLIC_URL },
    modules: { connections: { enabled: true }, assetManagement: { enabled: true } },
    secretStore: { keys: [{ id: "k1", ref: "CATALYST_SECRET_STORE_KEY" }] },
    egress: {
      allow: [
        {
          protocol: "http",
          host: "127.0.0.1",
          port: samplePort,
          network: "private",
          cidrs: ["127.0.0.1/32"]
        },
        // The same server by another name: a Connection moved to it has another origin.
        {
          protocol: "http",
          host: "localhost",
          port: samplePort,
          network: "private",
          cidrs: ["127.0.0.1/32", "::1/128"]
        }
      ]
    },
    connections: {
      dcr: {
        connectorType: "mcp",
        displayName: "Sample by registration",
        settings: { url: `${sampleBase}/dcr/mcp` },
        authScheme: "oauth",
        operations: [{ name: "list_customers", effect: "reading", exposure: ["agent"] }]
      },
      // A key where the server wants a sign-in: the server answers with its challenge.
      keyed: {
        connectorType: "mcp",
        displayName: "Sample with a key",
        settings: { url: `${sampleBase}/dcr/mcp` },
        authScheme: "bearer",
        secret: "SAMPLE_MCP_KEY",
        operations: [{ name: "list_customers", effect: "reading", exposure: ["agent"] }]
      },
      registered: {
        connectorType: "mcp",
        displayName: "Sample by issued client",
        settings: {
          url: `${sampleBase}/registered/mcp`,
          oauth: { clientId: REGISTERED_CLIENT_ID }
        },
        authScheme: "oauth",
        secret: "REGISTERED_CLIENT_SECRET",
        operations: [{ name: "list_customers", effect: "reading", exposure: ["agent"] }]
      }
    }
  });
  const instance = await createTestInstance({
    config,
    env: {
      CATALYST_SECRET_STORE_KEY: generateSecretStoreKey(),
      BETTER_AUTH_SECRET: generateTestSecret(),
      ALICE_PASSWORD: passwords.alice,
      BOB_PASSWORD: passwords.bob,
      REGISTERED_CLIENT_SECRET: clientSecret,
      SAMPLE_MCP_KEY: sampleKey,
      CHAT_SESSION_TOKEN_SECRET: generateTestSecret(),
      CHAT_SERVER_CREDENTIAL: serverCredential,
      SERVICE_ACCESS_TOKEN_SECRET: generateTestSecret()
    },
    tools: [],
    seedAssets: false
  });
  const api = await listenTestInstance(instance);

  return {
    instance,
    api,
    sample: sampleBase,
    trap: trap.trap,
    secrets,
    clientSecret,
    provider,
    async embeddedToken() {
      const response = await fetch(`${api}/api/v1/instance/session-tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-server-credential": serverCredential },
        // An administrator: refused as no person in a browser, not for a right.
        body: JSON.stringify({
          externalUserId: "embedded-alice",
          displayLabel: "Alice",
          roles: ["user", "admin"]
        })
      });
      const answer: unknown = await response.json();
      if (response.status !== 200) throw new Error(`Session token: ${JSON.stringify(answer)}`);
      return tokenAnswerSchema.parse(answer).chatSessionToken;
    },
    async servicePrincipalToken() {
      const clientInstanceId = asClientInstanceId(config.clientInstance.id);
      const principal = await instance.stores.apiAccess.createServicePrincipal({
        clientInstanceId,
        displayLabel: "Automation",
        permissions: []
      });
      const credential = await instance.stores.apiAccess.createApiCredential({
        clientInstanceId,
        servicePrincipalId: principal.id,
        name: "automation key",
        scopes: ["config_assets:read", "config_assets:write"]
      });
      const response = await fetch(`${api}/api/v1/auth/access-token`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential.secret}` }
      });
      const answer: unknown = await response.json();
      if (response.status !== 200) throw new Error(`Access token: ${JSON.stringify(answer)}`);
      return accessTokenSchema.parse(answer).accessToken;
    },
    async signIn(person, again) {
      const known = sessions.get(person);
      if (known !== undefined && again === undefined) return known;
      const response = await fetch(`${api}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: PUBLIC_URL },
        body: JSON.stringify({ email: PEOPLE[person], password: passwords[person] })
      });
      if (response.status !== 200) throw new Error(`Sign-in of ${person}: ${response.status}`);
      signInAnswerSchema.parse(await response.json());
      const cookie = cookieOf(response);
      if (known === undefined) sessions.set(person, cookie);
      return cookie;
    },
    async userIdOf(cookie) {
      const response = await fetch(`${api}/api/v1/me`, { headers: { cookie } });
      return meSchema.parse(await response.json()).id;
    },
    async start(name, cookie) {
      const response = await fetch(`${api}/api/v1/connections/${name}/oauth/start`, {
        method: "POST",
        headers: { cookie, origin: PUBLIC_URL, "content-type": "application/json" },
        body: "{}"
      });
      return { status: response.status, body: await response.json() };
    },
    async startWithToken(name, token) {
      const response = await fetch(`${api}/api/v1/connections/${name}/oauth/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}"
      });
      await response.body?.cancel();
      return response.status;
    },
    async test(name, cookie) {
      const response = await fetch(`${api}/api/v1/connections/${name}/test`, {
        method: "POST",
        headers: { cookie, origin: PUBLIC_URL, "content-type": "application/json" },
        body: "{}"
      });
      return { status: response.status, text: await response.text() };
    },
    async detail(name, cookie) {
      const response = await fetch(`${api}/api/v1/connections/${name}`, { headers: { cookie } });
      return response.text();
    },
    async putConnection(name, config, cookie) {
      const stored = await instance.stores.configAssets.getConfigAsset({
        clientInstanceId: asClientInstanceId("demo-local"),
        kind: "connection",
        name
      });
      const answer = await instance.call(
        "assets.put",
        {
          params: { kind: "connection", name },
          payload: { config: { name, ...config }, expectedRevision: stored?.revision ?? null }
        },
        { headers: { cookie, origin: PUBLIC_URL } }
      );
      return answer.statusCode;
    },
    async authorize(authorizationUrl) {
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status !== 302 || location === null) {
        throw new Error(`The provider answered ${response.status}`);
      }
      return new URL(location);
    },
    async callback(providerRedirect, headers = {}) {
      const response = await fetch(`${api}${providerRedirect.pathname}${providerRedirect.search}`, {
        redirect: "manual",
        headers
      });
      return {
        status: response.status,
        location: response.headers.get("location"),
        body: await response.text()
      };
    },
    async close() {
      await instance.close();
      await sample.close();
      await trap.close();
    }
  };
}

/** A free port on the loopback address, so the issuer's address is known before it listens. */
async function reservePort(): Promise<number> {
  const server = createServer();
  const base = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return Number(new URL(base).port);
}

/** The outcome and the Connection a landing address names, and nothing else it holds. */
export function landingOf(location: string | null): Record<string, string> {
  if (location === null) throw new Error("No redirect");
  const url = new URL(location);
  if (`${url.origin}${url.pathname}` !== LANDING) throw new Error(`Landed elsewhere: ${location}`);
  return Object.fromEntries(url.searchParams);
}

/** The rows of a table of the test database, for what a test must find there or not. */
export function countRows(table: "connection_bindings" | "secrets"): Promise<number> {
  return withTestSql(async (sql) => {
    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from ${sql(table)}`;
    return Number(row?.count ?? 0);
  });
}
