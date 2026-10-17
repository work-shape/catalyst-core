import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  callbackPathOf,
  createOAuthWorld,
  redirectUriOf,
  landingOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { withTestSql } from "./support/test-sql";
import { asClientInstanceId } from "@work-shape/catalyst-core";

// CS-4b2, check 52 of connections-and-secrets.md: each way a sign-in is refused, with its
// reason, and that a refused one stores nothing: no token set, no binding, no other session.
// A start answers its refusal; a callback lands on the fixed in-app page with the reason.

const startAnswerSchema = z.object({ authorizationUrl: z.string().url() });
const refusalSchema = z.object({
  error: z.object({ code: z.string(), details: z.object({ reason: z.string() }).optional() })
});

let world: OAuthWorld;

beforeAll(async () => {
  world = await createOAuthWorld();
}, 60_000);

afterAll(async () => {
  await world?.close();
});

afterEach(() => {
  delete world.provider.adjustMetadata;
  delete world.provider.adjustRegistration;
});

/** What a sign-in may have stored: bindings, token sets and setup sessions. */
function stored() {
  return withTestSql(async (sql) => ({
    bindings: await sql`select connection_asset_id, state, row_version from connection_bindings`,
    tokenSets: await sql`select subject, version from secrets where subject like 'oauth:%'`
  }));
}

async function startedBy(name: string, cookie: string): Promise<URL> {
  const started = await world.start(name, cookie);
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  return world.authorize(startAnswerSchema.parse(started.body).authorizationUrl);
}

function reasonOf(answer: { body: unknown }): string {
  return refusalSchema.parse(answer.body).error.details?.reason ?? "";
}

async function refusals(): Promise<{ reason: string | null; stage: unknown }[]> {
  return withTestSql(
    (sql) => sql<{ reason: string | null; stage: unknown }[]>`
      select reason, metadata->>'stage' as stage from audit_events
      where type = 'connection.oauth_refused' order by created_at`
  );
}

describe("a callback", () => {
  it("refuses a reused state with oauth_state_invalid and stores nothing more", async () => {
    const alice = await world.signIn("alice");
    const back = await startedBy("registered", alice);
    expect(landingOf((await world.callback(back, { cookie: alice })).location)).toEqual({
      signIn: "connected",
      connection: "registered"
    });
    const before = await stored();
    const again = await world.callback(back, { cookie: alice });
    expect(again.status).toBe(303);
    expect(landingOf(again.location)).toEqual({ signIn: "oauth_state_invalid" });
    expect(await stored()).toEqual(before);
    expect((await refusals()).at(-1)).toEqual({ reason: "oauth_state_invalid", stage: "callback" });
  });

  it("refuses the state of another person, also another administrator", async () => {
    const back = await startedBy("dcr", await world.signIn("alice"));
    const before = await stored();
    const bob = await world.signIn("bob");
    expect(landingOf((await world.callback(back, { cookie: bob })).location)).toEqual({
      signIn: "oauth_state_invalid"
    });
    expect(await stored()).toEqual(before);
  });

  it("refuses the starter in another signed-in session than the one that started", async () => {
    const back = await startedBy("dcr", await world.signIn("alice"));
    const elsewhere = await world.signIn("alice", "again");
    expect(landingOf((await world.callback(back, { cookie: elsewhere })).location)).toEqual({
      signIn: "oauth_state_invalid"
    });
  });

  it("refuses an expired session with oauth_session_expired", async () => {
    const alice = await world.signIn("alice");
    const back = await startedBy("dcr", alice);
    await withTestSql(
      (sql) => sql`update connection_setup_sessions set expires_at = now() - interval '1 second'`
    );
    const before = await stored();
    expect(landingOf((await world.callback(back, { cookie: alice })).location)).toEqual({
      signIn: "oauth_session_expired"
    });
    expect(await stored()).toEqual(before);
  });

  it("refuses a browser without a signed-in session, and an embedding host's session token", async () => {
    const alice = await world.signIn("alice");
    const back = await startedBy("dcr", alice);
    const before = await stored();
    const anonymous = await world.callback(back);
    expect(anonymous.status).toBe(303);
    expect(landingOf(anonymous.location)).toEqual({ signIn: "oauth_requires_person" });
    const embedded = await world.callback(back, {
      authorization: `Bearer ${await world.embeddedToken()}`
    });
    expect(landingOf(embedded.location)).toEqual({ signIn: "oauth_requires_person" });
    expect(await stored()).toEqual(before);
  });

  it("refuses a starter who lost connection.write since the start", async () => {
    const alice = await world.signIn("alice");
    const back = await startedBy("dcr", alice);
    const userId = await world.userIdOf(alice);
    await withTestSql(
      (sql) => sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, effect, granted_by, created_at)
        values ('grant_deny_alice', 'demo-local', 'user', ${userId}, 'connection.write', 'instance',
                'deny', 'test', now())`
    );
    try {
      const before = await stored();
      expect(landingOf((await world.callback(back, { cookie: alice })).location)).toEqual({
        signIn: "forbidden",
        connection: "dcr"
      });
      expect(await stored()).toEqual(before);
    } finally {
      await withTestSql((sql) => sql`delete from permission_grants where id = 'grant_deny_alice'`);
    }
  });

  it("refuses a Connection whose address changed since the start", async () => {
    const alice = await world.signIn("alice");
    const back = await startedBy("dcr", alice);
    const clientInstanceId = asClientInstanceId("demo-local");
    const asset = await world.instance.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: "dcr"
    });
    const config = asset?.config;
    if (!config) throw new Error("The Connection dcr is missing");
    const moved = { ...config, settings: { url: `${world.sample}/registered/mcp` } };
    await applyAtCurrentRevisions(world.instance.stores.configAssets, {
      clientInstanceId,
      mutations: [{ type: "upsert", kind: "connection", name: "dcr", config: moved }]
    });
    try {
      const before = await stored();
      expect(landingOf((await world.callback(back, { cookie: alice })).location)).toEqual({
        signIn: "oauth_connection_changed",
        connection: "dcr"
      });
      expect(await stored()).toEqual(before);
    } finally {
      await applyAtCurrentRevisions(world.instance.stores.configAssets, {
        clientInstanceId,
        mutations: [{ type: "upsert", kind: "connection", name: "dcr", config }]
      });
    }
  });

  it("ends the session when the person declined at the provider, with oauth_denied", async () => {
    const alice = await world.signIn("alice");
    const back = await startedBy("dcr", alice);
    const declined = new URL(back);
    declined.searchParams.delete("code");
    declined.searchParams.set("error", "access_denied");
    expect(landingOf((await world.callback(declined, { cookie: alice })).location)).toEqual({
      signIn: "oauth_denied",
      connection: "dcr"
    });
    expect(landingOf((await world.callback(back, { cookie: alice })).location)).toEqual({
      signIn: "oauth_state_invalid"
    });
  });

  it("sends no code to a token endpoint on another host than the issuer's or the Connection's", async () => {
    const alice = await world.signIn("alice");
    const back = await startedBy("dcr", alice);
    // The metadata changes between the start and the callback.
    world.provider.adjustMetadata = (_mode, kind, metadata) =>
      kind === "server" ? { ...metadata, token_endpoint: `${world.trap.base}/token` } : metadata;
    const before = await stored();
    expect(landingOf((await world.callback(back, { cookie: alice })).location)).toEqual({
      signIn: "oauth_discovery_failed",
      connection: "dcr"
    });
    expect(world.trap.hits()).toBe(0);
    expect(await stored()).toEqual(before);
  });

  it("takes a callback only at the path of the Connection that started it", async () => {
    const alice = await world.signIn("alice");
    const back = await startedBy("dcr", alice);
    const before = await stored();
    const elsewhere = new URL(back);
    elsewhere.pathname = callbackPathOf("registered");
    expect(landingOf((await world.callback(elsewhere, { cookie: alice })).location)).toMatchObject({
      signIn: "oauth_state_invalid"
    });
    // The state was taken: the right path refuses it too, and nothing was connected.
    expect(landingOf((await world.callback(back, { cookie: alice })).location)).toMatchObject({
      signIn: "oauth_state_invalid"
    });
    expect(await stored()).toEqual(before);
  });
  it("refuses an answer that names another issuer, or none where the server sends one", async () => {
    const alice = await world.signIn("alice");
    for (const iss of [`${world.sample}/registered`, undefined]) {
      const back = await startedBy("dcr", alice);
      const before = await stored();
      const forged = new URL(back);
      if (iss === undefined) forged.searchParams.delete("iss");
      else forged.searchParams.set("iss", iss);
      expect(landingOf((await world.callback(forged, { cookie: alice })).location)).toEqual({
        signIn: "oauth_issuer_mismatch",
        connection: "dcr"
      });
      expect(await stored()).toEqual(before);
    }
  });
});

describe("a start", () => {
  it("is refused for an embedding host's session token and a Service Principal's key", async () => {
    const sessions = () => withTestSql((sql) => sql`select id from connection_setup_sessions`);
    const before = await sessions();
    const embedded = await world.startWithToken("dcr", await world.embeddedToken());
    // Its token holds no scope to change config; the operation would refuse it as no person.
    expect(embedded).toBe(403);
    const principal = await world.startWithToken("dcr", await world.servicePrincipalToken());
    expect(principal).toBe(403);
    expect(await sessions()).toEqual(before);
  });

  it("refuses an authorization server without S256", async () => {
    const alice = await world.signIn("alice");
    for (const methods of [["plain"], undefined]) {
      world.provider.adjustMetadata = (_mode, kind, metadata) =>
        kind === "server" ? { ...metadata, code_challenge_methods_supported: methods } : metadata;
      const answer = await world.start("dcr", alice);
      expect(answer.status).toBe(409);
      expect(reasonOf(answer)).toBe("oauth_pkce_unsupported");
    }
  });

  it("refuses an issuer other than the one asked, and tolerates one trailing slash", async () => {
    const alice = await world.signIn("alice");
    world.provider.adjustMetadata = (_mode, kind, metadata) =>
      kind === "server" ? { ...metadata, issuer: `${world.sample}/other` } : metadata;
    const other = await world.start("dcr", alice);
    expect(reasonOf(other)).toBe("oauth_issuer_mismatch");

    world.provider.adjustMetadata = (_mode, kind, metadata) =>
      kind === "server" ? { ...metadata, issuer: `${world.sample}/dcr/` } : metadata;
    expect((await world.start("dcr", alice)).status).toBe(200);
  });

  it("sends nothing to a metadata endpoint off the egress list, or a registration endpoint on another host", async () => {
    const alice = await world.signIn("alice");
    world.provider.adjustMetadata = (_mode, kind, metadata) =>
      kind === "resource"
        ? { ...metadata, authorization_servers: [`${world.trap.base}/dcr`] }
        : metadata;
    const metadata = await world.start("dcr", alice);
    expect(reasonOf(metadata)).toBe("egress_denied");

    await forgetRegisteredClient();
    world.provider.adjustMetadata = (_mode, kind, metadata) =>
      kind === "server"
        ? { ...metadata, registration_endpoint: `${world.trap.base}/register` }
        : metadata;
    const registration = await world.start("dcr", alice);
    expect(reasonOf(registration)).toBe("oauth_discovery_failed");
    expect(world.trap.hits()).toBe(0);
  });

  it("refuses a token, registration or revocation endpoint on another host than the issuer's or the Connection's", async () => {
    const alice = await world.signIn("alice");
    for (const field of ["token_endpoint", "registration_endpoint", "revocation_endpoint"]) {
      world.provider.adjustMetadata = (_mode, kind, metadata) =>
        kind === "server" ? { ...metadata, [field]: `${world.trap.base}/${field}` } : metadata;
      const answer = await world.start("dcr", alice);
      expect(answer.status, field).toBe(409);
      expect(reasonOf(answer), field).toBe("oauth_discovery_failed");
    }
    expect(world.trap.hits()).toBe(0);
  });

  it("refuses a challenge that names resource metadata on another host than the Connection's", async () => {
    const alice = await world.signIn("alice");
    world.oauth.controls.challengeMetadataBase = world.trap.base;
    try {
      const answer = await world.start("dcr", alice);
      expect(answer.status).toBe(409);
      expect(reasonOf(answer)).toBe("oauth_discovery_failed");
      expect(world.trap.hits()).toBe(0);
    } finally {
      world.oauth.controls.challengeMetadataBase = undefined;
    }
  });

  it("refuses a registration that names other redirect URIs than the instance's", async () => {
    await forgetRegisteredClient();
    world.provider.adjustRegistration = (answer) => ({
      ...answer,
      redirect_uris: [redirectUriOf("dcr"), "https://elsewhere.example.test/callback"]
    });
    const answer = await world.start("dcr", await world.signIn("alice"));
    expect(answer.status).toBe(409);
    expect(reasonOf(answer)).toBe("oauth_registration_refused");
    expect(
      await withTestSql(
        (sql) => sql`select oauth_client from connection_state where oauth_client is not null
          and oauth_client->>'redirectUri' <> ${redirectUriOf("dcr")}`
      )
    ).toEqual([]);
  });

  it("refuses to send the browser to a plain http authorization endpoint off the machine", async () => {
    const alice = await world.signIn("alice");
    world.provider.adjustMetadata = (_mode, kind, metadata) =>
      kind === "server"
        ? { ...metadata, authorization_endpoint: "http://auth.example.test/authorize" }
        : metadata;
    const answer = await world.start("dcr", alice);
    expect(answer.status).toBe(409);
    expect(reasonOf(answer)).toBe("oauth_discovery_failed");
  });

  it("names the refusals in audit events with their reason and stage", async () => {
    const recorded = await refusals();
    expect(recorded.length).toBeGreaterThan(8);
    expect(recorded.every((row) => row.reason !== null)).toBe(true);
    expect(new Set(recorded.map((row) => row.stage))).toEqual(new Set(["start", "callback"]));
  });
});

describe("a change of the Connection", () => {
  const moving = (url: string, authScheme = "oauth") => ({
    displayName: "Moves",
    connectorType: "mcp",
    settings: { url },
    authScheme,
    operations: [],
    enabled: true
  });

  async function signInAt(name: string, cookie: string) {
    const back = await startedBy(name, cookie);
    expect(landingOf((await world.callback(back, { cookie })).location)).toEqual({
      signIn: "connected",
      connection: name
    });
    expect(await testStatus(name, cookie)).toBe("ready");
  }

  async function testStatus(name: string, cookie: string): Promise<string> {
    const { text } = await world.test(name, cookie);
    return z.object({ status: z.string() }).parse(JSON.parse(text)).status;
  }

  async function signInOf(name: string) {
    return withTestSql(
      (sql) => sql<{ state: string; tokens: number }[]>`
        select b.state,
          (select count(*)::int from secrets s
            where s.connection_asset_id = a.id and s.subject = 'oauth:shared') as tokens
        from config_assets a join connection_bindings b on b.connection_asset_id = a.id
        where a.kind = 'connection' and a.name = ${name} and a.status = 'active'`
    );
  }

  it("ends the sign-in when the address moves, so moving back needs a new one", async () => {
    const alice = await world.signIn("alice");
    const home = `${world.sample}/dcr/mcp`;
    expect(await world.putConnection("moving", moving(home), alice)).toBe(200);
    await signInAt("moving", alice);

    const port = new URL(world.sample).port;
    expect(
      await world.putConnection("moving", moving(`http://localhost:${port}/dcr/mcp`), alice)
    ).toBe(200);
    expect(await signInOf("moving")).toEqual([{ state: "revoked", tokens: 0 }]);
    expect(await world.putConnection("moving", moving(home), alice)).toBe(200);
    expect(await signInOf("moving")).toEqual([{ state: "revoked", tokens: 0 }]);
    expect(await testStatus("moving", alice)).toBe("oauth_required");
  });

  it("ends the sign-in when the Connection stops signing in, so turning it back needs a new one", async () => {
    const alice = await world.signIn("alice");
    const home = `${world.sample}/dcr/mcp`;
    expect(await world.putConnection("turning", moving(home), alice)).toBe(200);
    await signInAt("turning", alice);

    expect(await world.putConnection("turning", moving(home, "none"), alice)).toBe(200);
    expect(await signInOf("turning")).toEqual([{ state: "revoked", tokens: 0 }]);
    expect(await world.putConnection("turning", moving(home), alice)).toBe(200);
    expect(await testStatus("turning", alice)).toBe("oauth_required");
  });
});

/** Drops the client the platform registered, so the next start registers anew. */
function forgetRegisteredClient() {
  return withTestSql((sql) => sql`update connection_state set oauth_client = null`);
}
