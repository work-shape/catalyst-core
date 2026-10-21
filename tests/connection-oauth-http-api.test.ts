import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { captureProcessOutput, dumpDatabaseText, findLeak } from "./support/test-connector";
import {
  REST_CLIENT_ID,
  REST_CONNECTION,
  callbackPathOf,
  createOAuthWorld,
  landingOf,
  redirectUriOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { withTestSql } from "./support/test-sql";

// CONN-OAUTH-1: an `http_api` Connection that names its authorization server in its settings,
// against the demo sample's REST provider (`/oauth-rest`), which refuses an RFC 8707
// `resource` as Microsoft's v2 endpoints do and sends no `iss`. The sign-in is CS-4b's
// machinery; the client credentials grant keeps its token in memory only.

const startAnswerSchema = z.object({ authorizationUrl: z.string().url() });
const testAnswerSchema = z.object({ status: z.string() });
const detailSchema = z.object({
  binding: z.object({ state: z.string(), scopes: z.array(z.string()) }).optional(),
  oauth: z
    .object({
      registration: z.string(),
      redirectUri: z.string().optional(),
      providerHost: z.string().optional()
    })
    .optional()
});
const errorSchema = z.object({ error: z.object({ message: z.string() }) });

const customers = {
  name: "list_customers",
  effect: "reading",
  exposure: ["agent", "outside"],
  enabled: true,
  method: "GET",
  path: "/customers",
  description: "Lists the customers."
};

let world: OAuthWorld;
let output: { stop(): string } | undefined;
const answers: string[] = [];

beforeAll(async () => {
  world = await createOAuthWorld();
  output = captureProcessOutput();
}, 60_000);

afterAll(async () => {
  output?.stop();
  await world?.close();
});

/** The REST provider at `host`: the sample's address, or the same server by another name. */
function providerAt(host = new URL(world.sample).host) {
  const base = `http://${host}/oauth-rest`;
  return {
    authorizationUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    revocationUrl: `${base}/revoke`
  };
}

/** A runtime `http_api` Connection of the REST provider's API. */
function restConnection(
  authScheme: "oauth" | "oauth_client",
  oauth: Record<string, unknown> = {}
): Record<string, unknown> {
  const { authorizationUrl, ...addresses } = providerAt();
  return {
    displayName: "Sample REST",
    connectorType: "http_api",
    settings: {
      baseUrl: `${world.sample}/oauth-rest/api`,
      testPath: "/customers",
      oauth: {
        ...(authScheme === "oauth" ? { authorizationUrl } : {}),
        ...addresses,
        clientId: REST_CLIENT_ID,
        scopes: ["sample.read"],
        ...oauth
      }
    },
    authScheme,
    operations: [customers],
    enabled: true
  };
}

async function test(name: string, cookie: string): Promise<string> {
  const { status, text } = await world.test(name, cookie);
  answers.push(text);
  expect(status, text).toBe(200);
  return testAnswerSchema.parse(JSON.parse(text)).status;
}

async function signInFully(name: string, cookie: string) {
  const started = await world.start(name, cookie);
  answers.push(JSON.stringify(started.body));
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const { authorizationUrl } = startAnswerSchema.parse(started.body);
  const back = await world.authorize(authorizationUrl);
  expect(back.searchParams.get("error")).toBeNull();
  const landed = await world.callback(back, { cookie });
  answers.push(landed.body);
  return { authorizationUrl: new URL(authorizationUrl), landed };
}

async function signInOf(name: string) {
  const [row] = await withTestSql(
    (sql) => sql<{ state: string; reason: string | null; secrets: number }[]>`
      select b.state, b.state_reason as reason,
        (select count(*)::int from secrets s where s.connection_asset_id = a.id) as secrets
      from config_assets a join connection_bindings b
        on b.connection_asset_id = a.id and b.subject = 'shared'
      where a.kind = 'connection' and a.name = ${name}
      limit 1`
  );
  return row;
}

async function secretsOf(name: string): Promise<string[]> {
  const rows = await withTestSql(
    (sql) => sql<{ subject: string }[]>`
      select s.subject from secrets s join config_assets a on a.id = s.connection_asset_id
      where a.kind = 'connection' and a.name = ${name} order by s.subject`
  );
  return rows.map((row) => row.subject);
}

describe("an http_api Connection that signs in with OAuth", () => {
  it("signs in at the server its settings name: no resource, its extra parameters, no discovery", async () => {
    const alice = await world.signIn("alice");
    const connection = restConnection("oauth", {
      authorizationParams: { access_type: "offline", prompt: "consent" }
    });
    expect(await world.putConnection(REST_CONNECTION, connection, alice)).toBe(200);
    expect(await world.setSecret(REST_CONNECTION, world.restClientSecret, alice)).toBe(200);
    expect(await test(REST_CONNECTION, alice)).toBe("oauth_required");

    const { authorizationUrl, landed } = await signInFully(REST_CONNECTION, alice);
    const asked = authorizationUrl.searchParams;
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      providerAt().authorizationUrl
    );
    expect(asked.get("client_id")).toBe(REST_CLIENT_ID);
    expect(asked.get("code_challenge_method")).toBe("S256");
    expect(asked.get("redirect_uri")).toBe(redirectUriOf(REST_CONNECTION));
    expect(asked.get("scope")).toBe("sample.read");
    expect(asked.has("resource")).toBe(false);
    expect(world.oauth.lastExtraParams()).toEqual({ access_type: "offline", prompt: "consent" });
    expect(landingOf(landed.location)).toEqual({
      signIn: "connected",
      connection: REST_CONNECTION
    });

    expect(await test(REST_CONNECTION, alice)).toBe("ready");
    const text = await world.detail(REST_CONNECTION, alice);
    answers.push(text);
    const read = detailSchema.parse(JSON.parse(text));
    expect(read.binding).toMatchObject({ state: "connected", scopes: ["sample.read"] });
    expect(read.oauth).toEqual({
      registration: "preregistered",
      redirectUri: redirectUriOf(REST_CONNECTION),
      providerHost: new URL(world.sample).host
    });
    // The client secret and the token set, each in the Secret Store and nowhere else.
    expect(await secretsOf(REST_CONNECTION)).toEqual(["oauth:shared", "shared"]);
    const outcome = await world.call(REST_CONNECTION, "list_customers", alice);
    answers.push(JSON.stringify(outcome.result));
    expect(outcome.result).toMatchObject({ status: "done" });
  });

  it("refreshes a token the API refused and makes the reading call once more", async () => {
    const alice = await world.signIn("alice");
    const before = world.oauth.counts();
    world.oauth.expireAccessTokens();
    const outcome = await world.call(REST_CONNECTION, "list_customers", alice);
    answers.push(JSON.stringify(outcome.result));
    expect(outcome.result).toMatchObject({ status: "done" });
    expect(world.oauth.counts().refreshToken - before.refreshToken).toBe(1);
  });

  it("ends the sign-in and the client secret when the token address moves to another host", async () => {
    const alice = await world.signIn("alice");
    const elsewhere = providerAt(`localhost:${new URL(world.sample).port}`);
    const before = world.oauth.counts();
    const moved = restConnection("oauth", { tokenUrl: elsewhere.tokenUrl });
    expect(await world.putConnection(REST_CONNECTION, moved, alice)).toBe(200);
    // The provider was told with the client secret of the old address, then both were gone.
    expect(world.oauth.counts().revocation - before.revocation).toBe(1);
    expect(await signInOf(REST_CONNECTION)).toMatchObject({
      state: "revoked",
      reason: "origin_changed",
      secrets: 0
    });
    expect(await test(REST_CONNECTION, alice)).not.toBe("ready");
  });

  it("refuses a token address the egress list does not admit, before anything is stored", async () => {
    const alice = await world.signIn("alice");
    const refused = restConnection("oauth", { tokenUrl: `${world.trap.base}/token` });
    const answer = await world.instance.call(
      "assets.put",
      {
        params: { kind: "connection", name: "trapped" },
        payload: { config: { name: "trapped", ...refused }, expectedRevision: null }
      },
      { headers: { cookie: alice, origin: "http://localhost:5173" } }
    );
    expect(answer.statusCode).toBe(422);
    // The issue names the refused address of the token endpoint, under `settings.oauth`.
    const text = JSON.stringify(answer.json());
    expect(text).toContain(`egress_denied: the address 127.0.0.1:${new URL(world.trap.base).port}`);
    expect(text).toContain('"oauth"');
    expect(world.trap.hits()).toBe(0);
  });

  it("refuses settings that name a protocol parameter or no authorization address", async () => {
    const alice = await world.signIn("alice");
    for (const oauth of [
      { authorizationParams: { client_secret: "x" } },
      { authorizationParams: { resource: "https://example.test" } },
      { authorizationUrl: undefined }
    ]) {
      const definition = restConnection("oauth", oauth);
      const answer = await world.instance.call(
        "assets.put",
        {
          params: { kind: "connection", name: "invalid" },
          payload: { config: { name: "invalid", ...definition }, expectedRevision: null }
        },
        { headers: { cookie: alice, origin: "http://localhost:5173" } }
      );
      expect(answer.statusCode, JSON.stringify(oauth)).toBe(422);
      errorSchema.parse(answer.json());
    }
  });
});

describe("an http_api Connection with the client credentials grant", () => {
  it("asks once for a token that concurrent calls share, and again after the API refused it", async () => {
    const alice = await world.signIn("alice");
    const definition = restConnection("oauth_client", { tokenAuthMethod: "client_secret_basic" });
    expect(await world.putConnection("machine", definition, alice)).toBe(200);
    expect(await world.setSecret("machine", world.restClientSecret, alice)).toBe(200);
    const before = world.oauth.counts();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => world.call("machine", "list_customers", alice))
    );
    for (const outcome of outcomes) {
      answers.push(JSON.stringify(outcome.result));
      expect(outcome.result).toMatchObject({ status: "done" });
    }
    expect(world.oauth.counts().clientCredentials - before.clientCredentials).toBe(1);

    world.oauth.expireAccessTokens();
    const again = await world.call("machine", "list_customers", alice);
    expect(again.result).toMatchObject({ status: "done" });
    expect(world.oauth.counts().clientCredentials - before.clientCredentials).toBe(2);
    // The token is kept nowhere but in memory: the Connection holds its client secret only.
    expect(await secretsOf("machine")).toEqual(["shared"]);
    expect(await test("machine", alice)).toBe("ready");
  });

  it("answers unauthorized with a client secret the token endpoint refuses", async () => {
    const alice = await world.signIn("alice");
    const [record] = await withTestSql(
      (sql) => sql<{ version: number }[]>`
        select s.version from secrets s join config_assets a on a.id = s.connection_asset_id
        where a.name = 'machine' and s.subject = 'shared'`
    );
    const wrong = "a-client-secret-the-provider-never-issued";
    expect(await world.setSecret("machine", wrong, alice, record?.version ?? null)).toBe(200);
    const outcome = await world.call("machine", "list_customers", alice);
    answers.push(JSON.stringify(outcome.result));
    expect(JSON.stringify(outcome.result)).toContain("upstream_unauthorized");
    expect(await test("machine", alice)).toBe("unauthorized");
  });

  it("keeps the client secret, the codes and every token out of logs, answers and the database", async () => {
    const logged = output?.stop() ?? "";
    output = undefined;
    expect(logged).not.toContain(callbackPathOf(REST_CONNECTION));
    const database = await dumpDatabaseText();
    const everything = [...world.secrets, world.restClientSecret];
    expect(everything.length).toBeGreaterThan(6);
    for (const value of everything) {
      expect(findLeak(logged, value)).toBeUndefined();
      expect(findLeak(database, value)).toBeUndefined();
      expect(findLeak(answers.join("\n"), value)).toBeUndefined();
    }
    const events = await withTestSql(
      (sql) => sql<{ metadata: unknown }[]>`
        select metadata from audit_events where subject in (${REST_CONNECTION}, 'machine')`
    );
    for (const value of everything) {
      expect(findLeak(JSON.stringify(events), value)).toBeUndefined();
    }
  });
});
