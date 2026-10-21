import { createServer, type Server } from "node:http";
import { z } from "zod";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  asClientInstanceId,
  asUserId,
  connectionOAuthCallbackPath,
  type AuthenticatedIdentity
} from "@work-shape/catalyst-core";
import { runOperation, type OperationOutcome } from "@work-shape/catalyst-tool-execution";
import type { SampleOAuthOptions } from "@work-shape/catalyst-demo/sample-mcp";
import { createSampleMcpServer } from "@work-shape/catalyst-demo/sample-mcp";
import { createTestConfig } from "./fixtures";
import { generateSecretStoreKey, generateTestSecret } from "./test-connector";
import {
  createTestInstance,
  getTestExecution,
  getTestJobs,
  listenTestInstance,
  type TestInstance
} from "./test-instance";
import { withTestSql } from "./test-sql";

// The world of the shared OAuth sign-in tests (CS-4b2): an assembled instance with real
// sign-in by password (so a request carries a first-party session), the demo's sample MCP
// server with its authorization server in front, and a trap server the egress list leaves
// out, which counts every request that reaches it.

/** The browser origin of the instance, `instance.publicUrl`. Nothing listens there. */
const PUBLIC_URL = "http://localhost:5173";
/** The callback path of one Connection's sign-in. */
export const callbackPathOf = (connectionName: string) =>
  connectionOAuthCallbackPath(connectionName);
/** The redirect URI the instance names for one Connection. */
export const redirectUriOf = (connectionName: string) =>
  `${PUBLIC_URL}${callbackPathOf(connectionName)}`;
const LANDING = `${PUBLIC_URL}/build/connections`;
/** The client the provider issued for the Connection `registered`. */
export const REGISTERED_CLIENT_ID = "catalyst-registered";
/** The client the sample's REST provider issued, for `http_api` Connections (CONN-OAUTH-1). */
export const REST_CLIENT_ID = "catalyst-rest";
/** The `http_api` Connection a test makes to sign in at the REST provider. */
export const REST_CONNECTION = "rest";

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
  /** A worker process of the instance on the same rows, where the calls run. */
  readonly worker: TestInstance;
  /** The address the test reaches the instance at. */
  readonly api: string;
  /** The sample MCP server's base, as the instance reaches it. */
  readonly sample: string;
  readonly trap: TrapServer;
  /** Every code, verifier and token the authorization server issued or received. */
  readonly secrets: string[];
  /** The client secret of the Connection `registered`. */
  readonly clientSecret: string;
  /** The client secret of the REST provider's client. */
  readonly restClientSecret: string;
  /** What the sample's metadata and registration say. A test sets them and resets after. */
  readonly provider: {
    adjustMetadata?: SampleOAuthOptions["adjustMetadata"];
    adjustRegistration?: SampleOAuthOptions["adjustRegistration"];
    beforeRevoke?: SampleOAuthOptions["beforeRevoke"];
  };
  /** The authorization server's switches and counts. */
  readonly oauth: SampleOAuthHandle;
  /** The identity of the person whose session `cookie` is, as the call path is handed it. */
  identityOf(cookie: string): Promise<AuthenticatedIdentity>;
  /** The call path of a worker process of the instance, on the same rows. */
  calls(): Promise<ReturnType<typeof getTestExecution>["operationCalls"]>;
  /** A Connection operation called by the person as the CLI calls it. */
  call(connectionName: string, operation: string, cookie: string): Promise<OperationOutcome>;
  /** `connections.discover` in the person's browser session, and the discovery run. */
  discover(name: string, cookie: string): Promise<void>;
  /** `connections.disconnect` in the person's browser session. */
  disconnect(name: string, cookie: string): Promise<{ status: number; body: unknown }>;
  /** `assets.delete` of a runtime Connection in the person's browser session. */
  deleteConnection(name: string, cookie: string): Promise<number>;
  /** `assets.revert` of a runtime Connection to `revision`, in the person's browser session. */
  revertConnection(name: string, revision: number, cookie: string): Promise<number>;
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
  /**
   * `connections.set_secret` in the person's browser session, over the Connection's revision as
   * it stands now: its status.
   */
  setSecret(
    name: string,
    value: string,
    cookie: string,
    expectedVersion?: number | null
  ): Promise<number>;
  /** `connections.set_person_context` of a user in the person's browser session: its status. */
  setPersonContext(name: string, userId: string, value: string, cookie: string): Promise<number>;
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

type SampleOAuthHandle = NonNullable<ReturnType<typeof createSampleMcpServer>["oauth"]>;

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
  const restClientSecret = generateTestSecret();
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
      registeredClient: {
        clientId: REGISTERED_CLIENT_ID,
        clientSecret,
        redirectUri: redirectUriOf("registered")
      },
      restClient: {
        clientId: REST_CLIENT_ID,
        clientSecret: restClientSecret,
        redirectUri: redirectUriOf(REST_CONNECTION)
      },
      adjustMetadata: (mode, kind, metadata) =>
        provider.adjustMetadata?.(mode, kind, metadata) ?? metadata,
      adjustRegistration: (answer) => provider.adjustRegistration?.(answer) ?? answer,
      beforeRevoke: async () => provider.beforeRevoke?.(),
      onSecret: (value) => secrets.push(value)
    }
  });
  await sample.listen(samplePort, "127.0.0.1");
  const sampleOAuth = sample.oauth;
  if (!sampleOAuth) throw new Error("The sample serves no sign-in");

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
    modules: {
      connections: { enabled: true },
      assetManagement: { enabled: true },
      personalApiKeys: { enabled: true }
    },
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
        operations: [{ name: "list_customers", effect: "reading", exposure: ["agent", "outside"] }]
      },
      // A key where the server wants a sign-in: the server answers with its challenge.
      keyed: {
        connectorType: "mcp",
        displayName: "Sample with a key",
        settings: { url: `${sampleBase}/dcr/mcp` },
        authScheme: "bearer",
        secret: "SAMPLE_MCP_KEY",
        operations: [{ name: "list_customers", effect: "reading", exposure: ["agent", "outside"] }]
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
        operations: [{ name: "list_customers", effect: "reading", exposure: ["agent", "outside"] }]
      }
    }
  });
  const assembly = {
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
    tools: []
  };
  const instance = await createTestInstance({ ...assembly, seedAssets: false });
  const api = await listenTestInstance(instance);
  /** A worker process on the same rows: the calls of operations run there, as a Workflow's do. */
  const worker = await createTestInstance({ execution: assembly });
  async function callPath() {
    return getTestExecution(worker).operationCalls;
  }
  const clientInstanceId = asClientInstanceId(config.clientInstance.id);
  async function identityOf(cookie: string): Promise<AuthenticatedIdentity> {
    const response = await fetch(`${api}/api/v1/me`, { headers: { cookie } });
    const userId = asUserId(meSchema.parse(await response.json()).id);
    const user = await instance.stores.users.getUser({ clientInstanceId, userId });
    if (!user) throw new Error("No such user");
    return {
      id: user.id,
      externalUserId: user.id,
      displayLabel: user.displayLabel,
      roles: user.roles,
      permissions: user.permissions,
      permissionRefs: user.permissionRefs,
      clientInstanceId,
      authSource: "test",
      scopes: ["*"]
    };
  }
  async function assetCall(
    operation: "assets.delete" | "assets.revert",
    name: string,
    payload: Record<string, unknown>,
    cookie: string
  ): Promise<number> {
    const stored = await instance.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name
    });
    const answer = await instance.call(
      operation,
      {
        params: { kind: "connection", name },
        payload: { ...payload, expectedRevision: stored?.revision ?? null }
      },
      { headers: { cookie, origin: PUBLIC_URL } }
    );
    return answer.statusCode;
  }

  return {
    instance,
    worker,
    api,
    sample: sampleBase,
    trap: trap.trap,
    secrets,
    clientSecret,
    restClientSecret,
    provider,
    oauth: sampleOAuth,
    identityOf,
    calls: callPath,
    async call(connectionName, operation, cookie) {
      const calls = await callPath();
      return runOperation(
        {
          operation: `connection.${connectionName}.${operation}`,
          effect: "reading",
          input: {},
          actor: await identityOf(cookie),
          origin: { kind: "cli" },
          correlationId: `corr_${generateTestSecret().slice(0, 12)}`
        },
        calls.deps
      );
    },
    async disconnect(name, cookie) {
      const response = await fetch(`${api}/api/v1/connections/${name}/disconnect`, {
        method: "POST",
        headers: { cookie, origin: PUBLIC_URL, "content-type": "application/json" },
        body: "{}"
      });
      return { status: response.status, body: await response.json() };
    },
    async discover(name, cookie) {
      const response = await fetch(`${api}/api/v1/connections/${name}/discover`, {
        method: "POST",
        headers: { cookie, origin: PUBLIC_URL, "content-type": "application/json" },
        body: "{}"
      });
      if (!response.ok) throw new Error(`The discovery was not queued: ${response.status}`);
      // A pass runs as many jobs as the concurrency allows, the other Connections' first.
      for (let pass = 0; pass < 10; pass += 1) {
        await getTestJobs(instance).runDue();
        const [waiting] = await withTestSql(
          (sql) => sql<{ count: number }[]>`
            select count(*)::int as count from platform_jobs
            where kind = 'connection.discover' and subject = ${name}
              and status in ('queued', 'running')`
        );
        if (waiting?.count === 0) return;
      }
      throw new Error("The discovery did not run");
    },
    deleteConnection: (name, cookie) => assetCall("assets.delete", name, {}, cookie),
    revertConnection: (name, revision, cookie) =>
      assetCall("assets.revert", name, { revision }, cookie),
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
    async setSecret(name, value, cookie, expectedVersion = null) {
      const stored = await instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name
      });
      const response = await fetch(`${api}/api/v1/connections/${name}/secret`, {
        method: "PUT",
        headers: { cookie, origin: PUBLIC_URL, "content-type": "application/json" },
        body: JSON.stringify({
          value,
          expectedVersion,
          expectedRevision: stored?.revision ?? 1
        })
      });
      await response.body?.cancel();
      return response.status;
    },
    async setPersonContext(name, userId, value, cookie) {
      const response = await fetch(`${api}/api/v1/connections/${name}/person-context`, {
        method: "PUT",
        headers: { cookie, origin: PUBLIC_URL, "content-type": "application/json" },
        body: JSON.stringify({
          subjectKind: "user",
          subjectId: userId,
          value,
          expectedRowVersion: null
        })
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
      await worker.close();
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

/** Issues a personal key as the person `cookie` signs in, as Settings does. */
export function issuePersonalKey(
  world: Pick<OAuthWorld, "api">,
  cookie: string,
  input: { name: string; scopes: string[]; expiresAt: string }
): Promise<Response> {
  return fetch(`${world.api}/api/v1/me/api-keys`, {
    method: "POST",
    headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify(input)
  });
}

/** Reads a Connection's sign-in as the person `cookie` signs in. */
export function readSignIn(
  world: Pick<OAuthWorld, "api">,
  cookie: string,
  connection: string,
  signInId: string
): Promise<Response> {
  return fetch(`${world.api}/api/v1/connections/${connection}/oauth/sign-ins/${signInId}`, {
    headers: { cookie }
  });
}
