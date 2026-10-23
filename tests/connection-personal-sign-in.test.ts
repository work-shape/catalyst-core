import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runCli } from "@work-shape/catalyst-cli";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { asClientInstanceId, asUserId } from "@work-shape/catalyst-core";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { captureProcessOutput, findLeak, generateTestSecret } from "./support/test-connector";
import {
  createOAuthWorld,
  issuePersonalKey,
  landingOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { getTestExecution } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// CS-9a: real browser-session routes, real Secret Store and refresh lease, distinct grants
// and a loopback API that records the actual Authorization header, never echoing it back.
const instanceId = asClientInstanceId("demo-local");
const startSchema = z.object({ authorizationUrl: z.string() });
const mySchema = z.object({
  connections: z.array(
    z.object({ name: z.string(), state: z.string(), account: z.string().optional() })
  )
});
const peopleSchema = z.object({
  people: z.array(
    z.object({ userId: z.string(), state: z.string(), account: z.string().optional() })
  )
});
let world: OAuthWorld;
let fake: Awaited<ReturnType<typeof fakeProvider>>;
let capture: ReturnType<typeof captureProcessOutput>;
const answers: string[] = [];
const accountEmail = "outside-account@example.test";

beforeAll(async () => {
  fake = await fakeProvider();
  world = await createOAuthWorld({ extraPort: Number(new URL(fake.base).port) });
  capture = captureProcessOutput();
}, 60_000);
afterAll(async () => {
  capture?.stop();
  await world?.close();
  await fake?.close();
});

function definition(mode = "user", authScheme = "oauth", exposure = ["agent"]) {
  return {
    connectorType: "http_api",
    displayName: "Personal sample",
    service: "sample",
    credentialMode: mode,
    settings: {
      baseUrl: `${fake.base}/personal-api`,
      oauth: {
        authorizationUrl: `${fake.base}/authorize`,
        tokenUrl: `${fake.base}/token`,
        revocationUrl: `${fake.base}/revoke`,
        clientId: "personal-client",
        scopes: ["openid", "email", "sample.read"]
      }
    },
    authScheme,
    operations: [
      {
        name: "who",
        description: "Read the current account",
        method: "GET",
        path: "/who",
        effect: "reading",
        exposure,
        enabled: true
      }
    ],
    enabled: true
  };
}
async function create(name: string, cookie: string, mode = "user") {
  expect(
    await world.putConnection(
      name,
      definition(mode, "oauth", mode === "shared" ? ["agent", "outside"] : ["agent"]),
      cookie
    )
  ).toBe(200);
  expect(await world.setSecret(name, fake.clientSecret, cookie)).toBe(200);
}
async function connect(name: string, cookie: string, person: string) {
  const start = await world.start(name, cookie);
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const url = new URL(startSchema.parse(start.body).authorizationUrl);
  url.searchParams.set("person", person);
  const redirect = await world.authorize(url.href);
  const answer = await world.callback(redirect, { cookie });
  expect(landingOf(answer.location)).toEqual({ signIn: "connected", connection: name });
  answers.push(answer.body);
}
async function api(
  operation: "connections.mine" | "connections.people" | "connections.revoke_person",
  cookie: string,
  params: Record<string, string> = {}
) {
  const descriptor = apiOperations[operation];
  const response = await fetch(`${world.api}${descriptor.buildPath({ params })}`, {
    method: descriptor.method,
    headers: { cookie, origin: "http://localhost:5173" }
  });
  const text = await response.text();
  answers.push(text);
  return { status: response.status, body: JSON.parse(text) as unknown };
}

async function binding(name: string, userId: string) {
  return world.instance.stores.connections.getConnectionBinding({
    clientInstanceId: instanceId,
    connectionAssetId: (await asset(name)).id,
    subject: `user:${userId}`
  });
}
async function asset(name: string) {
  const asset = await world.instance.stores.configAssets.getConfigAsset({
    clientInstanceId: instanceId,
    kind: "connection",
    name
  });
  if (!asset) throw new Error("Missing Connection");
  return asset;
}
async function tokens(name: string, userId: string) {
  const id = (await asset(name)).id;
  const [row] = await withTestSql(
    (sql) => sql<{ count: number }[]>`select count(*)::int as count from secrets
    where connection_asset_id = ${id} and subject = ${`oauth:user:${userId}`}`
  );
  return row?.count;
}
async function expire(name: string, userId: string) {
  // Expiry is inside the encrypted token set; the fake issues a short-lived grant instead.
  expect((await binding(name, userId))?.accessExpiresAt).toBeDefined();
}

describe("personal OAuth sign-in lifecycle", () => {
  it("uses only each person's grant, in either order and concurrently, and exposes the intended display fields", async () => {
    const alice = await world.signIn("alice"),
      bob = await world.signIn("bob");
    await create("personal", alice);
    await connect("personal", alice, "A");
    await connect("personal", bob, "B");
    const aId = await world.userIdOf(alice),
      bId = await world.userIdOf(bob);
    expect((await binding("personal", aId))?.userId).toBe(aId);
    expect((await binding("personal", bId))?.userId).toBe(bId);
    const call = async (cookie: string) => {
      const answer = await world.call("personal", "who", cookie, "agent");
      answers.push(JSON.stringify(answer));
      expect(answer.result.status, JSON.stringify(answer.result)).toBe("done");
      return answer;
    };
    await call(alice);
    await call(bob);
    await call(bob);
    await call(alice);
    await Promise.all([call(alice), call(bob)]);
    const aToken = fake.lastAccess.get("A"),
      bToken = fake.lastAccess.get("B");
    expect(aToken).not.toBe(bToken);
    expect(fake.headers.slice(0, 4)).toEqual([
      `Bearer ${aToken}`,
      `Bearer ${bToken}`,
      `Bearer ${bToken}`,
      `Bearer ${aToken}`
    ]);
    expect(new Set(fake.headers.slice(4))).toEqual(
      new Set([`Bearer ${aToken}`, `Bearer ${bToken}`])
    );
    const client = createApiClient({
      baseUrl: world.api,
      fetchImpl: (url, init) =>
        fetch(url, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie: alice }
        })
    });
    const own = await client.connections.mine();
    expect(own.connections.find((connection) => connection.name === "personal")).toMatchObject({
      state: "connected",
      account: "Account A"
    });
    const people = await api("connections.people", alice, { name: "personal" });
    expect(people.status).toBe(200);
    expect(peopleSchema.parse(people.body).people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: aId, account: "Account A" }),
        expect.objectContaining({ userId: bId, account: "Account B" })
      ])
    );
  });

  it("does not fall back to shared or person-context rows, and supplies the chat card refusal", async () => {
    const alice = await world.signIn("alice"),
      bob = await world.signIn("bob");
    await create("missing", alice);
    await connect("missing", alice, "missing-A");
    const aId = await world.userIdOf(alice),
      id = (await asset("missing")).id;
    const a = await binding("missing", aId);
    if (!a) throw new Error("No owner binding");
    await world.instance.stores.connections.connectConnectionBinding({
      ...a,
      subject: "shared",
      userId: undefined,
      expectedRowVersion: null
    });
    await world.instance.stores.connections.setConnectionPersonContext({
      clientInstanceId: instanceId,
      connectionAssetId: id,
      subject: `person_context:user:${await world.userIdOf(bob)}`,
      header: "x-profile-id",
      origin: a.origin,
      value: "A",
      expectedRowVersion: null,
      changedBy: aId
    });
    const before = fake.headers.length;
    const answer = await world.call("missing", "who", bob, "agent");
    answers.push(JSON.stringify(answer));
    expect(answer.result).toMatchObject({
      status: "failed",
      error: {
        details: {
          reason: "connection_not_connected",
          state: "not_connected",
          connection: { name: "missing", title: "Personal sample", service: "sample" }
        }
      }
    });
    expect(JSON.stringify(answer)).toContain("Settings > You > Verbindungen");
    expect(fake.headers).toHaveLength(before);
  });

  it("requires the starting browser session and rejects caller-supplied subjects", async () => {
    const alice = await world.signIn("alice"),
      bob = await world.signIn("bob");
    await create("session", alice);
    for (const cookie of [bob, await world.signIn("alice", "again")]) {
      const started = await world.start("session", alice);
      const back = await world.authorize(startSchema.parse(started.body).authorizationUrl);
      const before = fake.exchanges;
      expect(landingOf((await world.callback(back, { cookie })).location).signIn).toBe(
        "oauth_state_invalid"
      );
      expect(fake.exchanges).toBe(before);
    }
    const response = await fetch(
      `${world.api}${apiOperations["connections.oauth_start"].buildPath({ params: { name: "session" } })}`,
      {
        method: "POST",
        headers: {
          cookie: alice,
          origin: "http://localhost:5173",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          userId: await world.userIdOf(bob),
          subject: `user:${await world.userIdOf(bob)}`
        })
      }
    );
    expect(response.status).toBe(200);
    const injected = startSchema.parse(await response.json());
    const injectedBack = await world.authorize(injected.authorizationUrl);
    expect(landingOf((await world.callback(injectedBack, { cookie: bob })).location).signIn).toBe(
      "oauth_state_invalid"
    );
    const valid = await world.start("session", alice);
    const back = await world.authorize(startSchema.parse(valid.body).authorizationUrl);
    back.searchParams.set("subject", `user:${await world.userIdOf(bob)}`);
    expect(landingOf((await world.callback(back, { cookie: alice })).location).signIn).toBe(
      "connected"
    );
    expect(await binding("session", await world.userIdOf(bob))).toBeUndefined();
    expect((await binding("session", await world.userIdOf(alice)))?.state).toBe("connected");
  });

  it("connects with connection.use alone, and denies People/revoke without connection.write", async () => {
    const alice = await world.signIn("alice"),
      bob = await world.signIn("bob"),
      bId = await world.userIdOf(bob);
    await create("use-only", alice);
    const user = await world.instance.stores.users.getUser({
      clientInstanceId: instanceId,
      userId: asUserId(bId)
    });
    if (!user) throw new Error("No user");
    await world.instance.stores.users.updateUser({
      clientInstanceId: instanceId,
      userId: asUserId(bId),
      roles: ["user"],
      permissions: ["connection.use"]
    });
    await world.instance.stores.access.createGrant({
      clientInstanceId: instanceId,
      holderKind: "user",
      holderId: bId,
      action: "connection.use",
      effect: "allow",
      scopeKind: "asset",
      scopeId: (await asset("use-only")).id,
      grantedBy: asUserId(await world.userIdOf(alice))
    });
    try {
      await connect("use-only", bob, "use-B");
      expect((await api("connections.people", bob, { name: "use-only" })).status).toBe(403);
      expect(
        (await api("connections.revoke_person", bob, { name: "use-only", userId: bId })).status
      ).toBe(403);
      expect(
        mySchema
          .parse((await api("connections.mine", bob)).body)
          .connections.find((entry) => entry.name === "use-only")?.state
      ).toBe("connected");
      expect((await world.disconnect("use-only", bob)).status).toBe(200);
    } finally {
      await world.instance.stores.users.updateUser({
        clientInstanceId: instanceId,
        userId: asUserId(bId),
        roles: user.roles,
        permissions: user.permissions
      });
    }
  });

  it("refreshes A once under concurrent calls while B's binding is unchanged; keep-alive touches shared only", async () => {
    const alice = await world.signIn("alice"),
      bob = await world.signIn("bob");
    const aId = await world.userIdOf(alice),
      bId = await world.userIdOf(bob);
    await create("refresh", alice);
    fake.ttl = 1;
    await connect("refresh", alice, "refresh-A");
    await connect("refresh", bob, "refresh-B");
    fake.ttl = 3600;
    await expire("refresh", aId);
    const before = fake.refreshes.length,
      b = await binding("refresh", bId);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => world.call("refresh", "who", alice, "agent"))
    );
    expect(outcomes.every((outcome) => outcome.result.status === "done")).toBe(true);
    expect(fake.refreshes.slice(before)).toEqual(["refresh-A"]);
    expect(await binding("refresh", bId)).toEqual(b);
    await create("keep-shared", alice, "shared");
    await connect("keep-shared", alice, "shared");
    await withTestSql(
      (sql) =>
        sql`update connection_bindings set connected_at = now() - interval '8 days', last_used_on = null, last_refreshed_at = null`
    );
    const keepBefore = fake.refreshes.length;
    const management = getTestExecution(world.worker).connections?.management;
    expect(await management?.keepAlive?.({ signal: new AbortController().signal })).toMatchObject({
      failed: 0
    });
    expect(fake.refreshes.slice(keepBefore)).toEqual(["shared"]);
  });

  it("ends only the owner binding on a refused refresh, with a structured reconnect reason", async () => {
    const alice = await world.signIn("alice"),
      bob = await world.signIn("bob");
    const aId = await world.userIdOf(alice),
      bId = await world.userIdOf(bob);
    await create("refusal", alice);
    fake.ttl = 1;
    await connect("refusal", alice, "refused-A");
    fake.ttl = 3600;
    await connect("refusal", bob, "refused-B");
    const b = await binding("refusal", bId),
      hits = fake.headers.length;
    fake.refuseRefresh = true;
    try {
      const outcome = await world.call("refusal", "who", alice, "agent");
      answers.push(JSON.stringify(outcome));
      expect(outcome.result).toMatchObject({
        status: "failed",
        error: {
          details: {
            reason: "connection_needs_reconnect",
            state: "needs_reconnect",
            stateReason: "invalid_grant",
            connection: { name: "refusal" }
          }
        }
      });
    } finally {
      fake.refuseRefresh = false;
    }
    expect(fake.headers).toHaveLength(hits);
    expect(await tokens("refusal", aId)).toBe(0);
    expect(await binding("refusal", bId)).toEqual(b);
  });

  it("signs in personal MCP accounts and ends only the caller's binding on a missing scope", async () => {
    const alice = await world.signIn("alice"),
      bob = await world.signIn("bob");
    const aId = await world.userIdOf(alice),
      bId = await world.userIdOf(bob);
    const started = await world.start("dcr", alice);
    const back = await world.authorize(startSchema.parse(started.body).authorizationUrl);
    expect(landingOf((await world.callback(back, { cookie: alice })).location).signIn).toBe(
      "connected"
    );
    await world.discover("dcr", alice);
    const shared = await world.instance.stores.connections.getConnectionState({
      clientInstanceId: instanceId,
      connectionAssetId: (await asset("dcr")).id
    });
    expect(
      await world.putConnection(
        "personal-mcp",
        {
          credentialMode: "user",
          authScheme: "oauth",
          connectorType: "mcp",
          displayName: "Personal MCP",
          settings: { url: `${world.sample}/dcr/mcp` },
          operations: [
            { name: "list_customers", effect: "reading", enabled: true, exposure: ["agent"] }
          ],
          enabled: true
        },
        alice
      )
    ).toBe(200);
    // Accepted MCP schemas are admin configuration. Reuse the sample's discovered catalog;
    // no background discovery opens either person's grant.
    await world.instance.stores.connections.putConnectionState({
      clientInstanceId: instanceId,
      connectionAssetId: (await asset("personal-mcp")).id,
      health: "unknown",
      catalog: shared?.catalog ?? null
    });
    for (const cookie of [alice, bob]) {
      const start = await world.start("personal-mcp", cookie);
      const redirect = await world.authorize(startSchema.parse(start.body).authorizationUrl);
      expect(landingOf((await world.callback(redirect, { cookie })).location).signIn).toBe(
        "connected"
      );
    }
    expect((await world.call("personal-mcp", "list_customers", alice, "agent")).result.status).toBe(
      "done"
    );
    const b = await binding("personal-mcp", bId);
    world.oauth.controls.requiredScope = "sample.read sample.extra";
    try {
      const outcome = await world.call("personal-mcp", "list_customers", alice, "agent");
      answers.push(JSON.stringify(outcome));
      expect(outcome.result).toMatchObject({
        status: "failed",
        error: {
          details: {
            reason: "connection_needs_reconnect",
            stateReason: "insufficient_scope",
            missingScopes: "sample.extra"
          }
        }
      });
    } finally {
      world.oauth.controls.requiredScope = undefined;
    }
    expect((await binding("personal-mcp", aId))?.state).toBe("needs_reconnect");
    expect(await tokens("personal-mcp", aId)).toBe(0);
    expect(await binding("personal-mcp", bId)).toEqual(b);
  });

  it("does not retain tokens when the owner is deactivated during the code exchange", async () => {
    const alice = await world.signIn("alice"),
      bob = await world.signIn("bob"),
      bId = await world.userIdOf(bob);
    await create("deactivation-race", alice);
    const start = await world.start("deactivation-race", bob);
    const back = await world.authorize(startSchema.parse(start.body).authorizationUrl);
    let arrive = () => {},
      resume = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    fake.beforeExchange = async () => {
      arrive();
      await paused;
    };
    const callback = world.callback(back, { cookie: bob });
    try {
      await arrived;
      await world.instance.stores.users.updateUser({
        clientInstanceId: instanceId,
        userId: asUserId(bId),
        status: "disabled"
      });
      resume();
      expect(landingOf((await callback).location).signIn).toBe("oauth_requires_person");
      expect(await tokens("deactivation-race", bId)).toBe(0);
    } finally {
      fake.beforeExchange = undefined;
      resume();
      await callback;
      await world.instance.stores.users.updateUser({
        clientInstanceId: instanceId,
        userId: asUserId(bId),
        status: "active"
      });
    }
  });

  it("deletes personal token sets on revoke, disable and delete without contacting the provider; owner Disconnect revokes once", async () => {
    const alice = await world.signIn("alice"),
      bob = await world.signIn("bob"),
      bId = await world.userIdOf(bob);
    await create("ends", alice);
    await connect("ends", bob, "end-B");
    let before = fake.revocations.length;
    expect(
      (await api("connections.revoke_person", alice, { name: "ends", userId: bId })).status
    ).toBe(200);
    expect(await tokens("ends", bId)).toBe(0);
    expect(fake.revocations).toHaveLength(before);
    await connect("ends", bob, "end-B");
    await world.instance.stores.users.updateUser({
      clientInstanceId: instanceId,
      userId: asUserId(bId),
      status: "disabled"
    });
    expect(await tokens("ends", bId)).toBe(0);
    expect(fake.revocations).toHaveLength(before);
    await world.instance.stores.users.updateUser({
      clientInstanceId: instanceId,
      userId: asUserId(bId),
      status: "active"
    });
    await connect("ends", bob, "end-B");
    expect(await world.deleteConnection("ends", alice)).toBe(200);
    expect(await tokens("ends", bId)).toBe(0);
    expect(fake.revocations).toHaveLength(before);
    await create("disconnect", alice);
    await connect("disconnect", bob, "disconnect-B");
    before = fake.revocations.length;
    expect((await world.disconnect("disconnect", bob)).status).toBe(200);
    expect(await tokens("disconnect", bId)).toBe(0);
    expect(fake.revocations.slice(before)).toEqual(["disconnect-B"]);
  });

  it("refuses mode changes, non-OAuth personal auth and every exposure except agent at save", async () => {
    const alice = await world.signIn("alice");
    await create("fixed-mode", alice);
    const fixed = await world.instance.call(
      "assets.put",
      {
        params: { kind: "connection", name: "fixed-mode" },
        payload: {
          expectedRevision: (await asset("fixed-mode")).revision,
          config: { name: "fixed-mode", ...definition("shared") }
        }
      },
      { headers: { cookie: alice, origin: "http://localhost:5173" } }
    );
    expect(fixed.statusCode).toBe(409);
    expect(fixed.json()).toMatchObject({ error: { details: { reason: "credential_mode_fixed" } } });
    for (const auth of ["bearer", "header", "none", "oauth_client"]) {
      expect(
        await world.putConnection(
          `invalid-${auth.replaceAll("_", "-")}`,
          definition("user", auth),
          alice
        )
      ).toBe(422);
    }
    for (const exposure of ["workflow", "bridge", "outside"]) {
      expect(
        await world.putConnection(
          `invalid-${exposure}`,
          definition("user", "oauth", [exposure]),
          alice
        )
      ).toBe(422);
    }
  });

  it("refuses personal CLI connect before starting a sign-in", async () => {
    const alice = await world.signIn("alice");
    await create("cli-personal", alice);
    const key = z.object({ secret: z.string() }).parse(
      await (
        await issuePersonalKey(world, alice, {
          name: "Personal CLI",
          scopes: ["connection.read", "connection.write"],
          expiresAt: new Date(Date.now() + 86_400_000).toISOString()
        })
      ).json()
    ).secret;
    const cwd = await mkdtemp(join(tmpdir(), "personal-oauth-cli-"));
    const errors: string[] = [];
    try {
      const before = fake.exchanges;
      expect(
        await runCli(["connection", "connect", "cli-personal", "--instance", world.api], {
          cwd,
          env: { CATALYST_API_KEY: key },
          stdin: Readable.from([]),
          stdout() {},
          stderr: (text) => errors.push(text)
        })
      ).toBe(1);
      expect(errors.join("")).toContain("personal_connect_in_browser");
      expect(fake.exchanges).toBe(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps account email and all fake credentials out of calls, audit, runs and captured output", async () => {
    const alice = await world.signIn("alice");
    await create("email-label", alice);
    await connect("email-label", alice, "email");
    // Account labels are an intentional field on the owner and People APIs. Every other
    // answer, event, log and Operation Run must exclude them.
    const owner = mySchema.parse((await api("connections.mine", alice)).body);
    expect(owner.connections.find((connection) => connection.name === "email-label")?.account).toBe(
      accountEmail
    );
    const persisted = await withTestSql(async (sql) => ({
      audit: await sql`select * from audit_events`,
      runs: await sql`select * from operation_runs`,
      bindings: await sql`select * from connection_bindings`
    }));
    const logs = capture.stop();
    for (const secret of [...fake.secrets, fake.clientSecret, accountEmail])
      expect(
        findLeak(JSON.stringify(persisted.audit) + JSON.stringify(persisted.runs) + logs, secret)
      ).toBeUndefined();
    for (const secret of fake.secrets)
      expect(
        findLeak(JSON.stringify(persisted.bindings) + JSON.stringify(answers), secret)
      ).toBeUndefined();
    const events = JSON.stringify(persisted.audit);
    expect(events).toContain('"subjectKind":"user"');
    expect(events).toContain('"userId":');
  });
});

async function fakeProvider() {
  let base = "",
    exchanges = 0,
    ttl = 3600,
    refuseRefresh = false;
  let beforeExchange: (() => Promise<void>) | undefined;
  const clientSecret = generateTestSecret(),
    secrets: string[] = [],
    headers: string[] = [],
    refreshes: string[] = [],
    revocations: string[] = [];
  const codes = new Map<string, { person: string; challenge: string; redirect: string }>();
  const refreshTokens = new Map<string, string>(),
    lastAccess = new Map<string, string>();
  const json = (response: ServerResponse, body: unknown, status = 200) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  function issue(person: string) {
    const access = `access-${randomUUID()}`,
      refresh = `refresh-${randomUUID()}`;
    lastAccess.set(person, access);
    refreshTokens.set(refresh, person);
    secrets.push(access, refresh);
    const claims =
      person === "email" ? { email: accountEmail } : { preferred_username: `Account ${person}` };
    const id = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.display-only`;
    secrets.push(id);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: ttl,
      scope: "openid email sample.read",
      id_token: id
    };
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", base);
    if (url.pathname === "/authorize") {
      const code = randomUUID();
      codes.set(code, {
        person: url.searchParams.get("person") ?? "unknown",
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirect: url.searchParams.get("redirect_uri") ?? ""
      });
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: back.href }).end();
      return;
    }
    if (url.pathname === "/personal-api/who") {
      headers.push(request.headers.authorization ?? "");
      json(response, { ok: true });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    if (form.get("client_secret") !== clientSecret) {
      json(response, { error: "invalid_client" }, 401);
      return;
    }
    if (url.pathname === "/revoke") {
      revocations.push(refreshTokens.get(form.get("token") ?? "") ?? "unknown");
      json(response, {});
      return;
    }
    if (form.get("grant_type") === "refresh_token") {
      const person = refreshTokens.get(form.get("refresh_token") ?? "");
      if (!person || refuseRefresh) {
        json(response, { error: "invalid_grant" }, 400);
        return;
      }
      refreshes.push(person);
      refreshTokens.delete(form.get("refresh_token") ?? "");
      json(response, issue(person));
      return;
    }
    const code = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? "");
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url");
    if (!code || code.challenge !== challenge || code.redirect !== form.get("redirect_uri")) {
      json(response, { error: "invalid_grant" }, 400);
      return;
    }
    await beforeExchange?.();
    exchanges += 1;
    json(response, issue(code.person));
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => json(response, {}, 500));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    clientSecret,
    secrets,
    headers,
    refreshes,
    revocations,
    lastAccess,
    get beforeExchange() {
      return beforeExchange;
    },
    set beforeExchange(value: (() => Promise<void>) | undefined) {
      beforeExchange = value;
    },
    get refuseRefresh() {
      return refuseRefresh;
    },
    set refuseRefresh(value: boolean) {
      refuseRefresh = value;
    },
    get exchanges() {
      return exchanges;
    },
    get ttl() {
      return ttl;
    },
    set ttl(value: number) {
      ttl = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
