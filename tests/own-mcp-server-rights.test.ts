import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  createOAuthWorld,
  issuePersonalKey,
  landingOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";

// A person's own MCP server (PMCP-2, connections acceptance checks 76 to 78): a person who holds
// `connection.add_own` and no Connection right adds an `mcp` Connection in mode `user` that only
// they read, use, change and delete. An instance admin reads it, switches it off and deletes
// it, and nothing more. Nobody else reaches it, a key with every scope included.

const clientInstanceId = asClientInstanceId("demo-local");
const PUBLIC_URL = "http://localhost:5173";
const reasonSchema = z.object({ error: z.object({ details: z.object({ reason: z.string() }) }) });
const testSchema = z.object({ status: z.string() });
const startSchema = z.object({ authorizationUrl: z.string() });
const discoveredSchema = z.object({ discovered: z.array(z.object({ name: z.string() })) });

let world: OAuthWorld;
let alice: string;
let carol: string;
let dave: string;
let carolId: string;
let probe: { base: string; port: number; seen: IncomingHttpHeaders[]; close(): Promise<void> };

/** A server that answers an MCP `initialize` by its path: 200, or 401 with no challenge. */
async function startProbeServer(): Promise<typeof probe> {
  const seen: IncomingHttpHeaders[] = [];
  const server: Server = createServer((request, response) => {
    seen.push(request.headers);
    request.resume();
    if (request.url === "/token/mcp") {
      response.writeHead(401, { "content-type": "application/json" }).end("{}");
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No TCP address");
  return {
    base: `http://127.0.0.1:${address.port}`,
    port: address.port,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

beforeAll(async () => {
  probe = await startProbeServer();
  world = await createOAuthWorld({
    plainPeople: true,
    extraPort: probe.port,
    // On, as an operator or PMCP-5 turns it on: the release default is off.
    ownServers: { enabled: true, perPerson: 3 }
  });
  alice = await world.signIn("alice");
  carol = await world.signIn("carol");
  dave = await world.signIn("dave");
  carolId = await world.userIdOf(carol);
}, 60_000);
afterAll(async () => {
  await world?.close();
  await probe?.close();
});

/** A self-added server's definition, at the sample's sign-in address unless named. */
function own(overrides: Record<string, unknown> = {}) {
  return {
    connectorType: "mcp",
    credentialMode: "user",
    authScheme: "oauth",
    displayName: "My notes",
    settings: { url: `${world.sample}/dcr/mcp` },
    operations: [],
    enabled: true,
    ownerOnly: true,
    ...overrides
  };
}

/** `assets.put` of a Connection in the person's session: status and refusal reason. */
async function put(
  name: string,
  config: Record<string, unknown>,
  cookie: string,
  extra: Record<string, unknown> = {}
) {
  const stored = await world.instance.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "connection",
    name
  });
  const answer = await world.instance.call(
    "assets.put",
    {
      params: { kind: "connection", name },
      payload: { config: { name, ...config }, expectedRevision: stored?.revision ?? null, ...extra }
    },
    { headers: { cookie, origin: PUBLIC_URL } }
  );
  return { status: answer.statusCode, reason: reasonOf(answer.body) };
}

function reasonOf(body: string): string | undefined {
  try {
    const parsed = reasonSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.error.details.reason : undefined;
  } catch {
    return undefined;
  }
}

/** One request to the API with the given headers: status and refusal reason. */
async function request(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
) {
  const response = await fetch(`${world.api}${path}`, {
    method,
    headers: {
      origin: PUBLIC_URL,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  return { status: response.status, reason: reasonOf(text), text };
}

const assetPath = (name: string) =>
  apiOperations["assets.get"].buildPath({ params: { kind: "connection", name } });

async function stored(name: string) {
  const record = await world.instance.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "connection",
    name
  });
  return record?.config ?? undefined;
}

async function bearerOf(cookie: string, scopes: string[]): Promise<string> {
  const issued = await issuePersonalKey(world, cookie, {
    name: `Key ${scopes.join(" ")}`,
    scopes,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString()
  });
  const answer: unknown = await issued.json();
  if (issued.status !== 200) throw new Error(`Key: ${issued.status} ${JSON.stringify(answer)}`);
  const secret = z.object({ secret: z.string() }).parse(answer).secret;
  const exchanged = await fetch(
    `${world.api}${apiOperations["access_tokens.exchange"].buildPath({})}`,
    { method: "POST", headers: { authorization: `Bearer ${secret}` } }
  );
  return z.object({ accessToken: z.string() }).parse(await exchanged.json()).accessToken;
}

describe("the self-add create (check 76)", () => {
  it("stores a person's own server with `ownerOnly`, the person as owner and no tool", async () => {
    expect(await put("carol-notes", own(), carol)).toEqual({ status: 200, reason: undefined });
    expect(await stored("carol-notes")).toMatchObject({
      ownerOnly: true,
      ownerPrincipalId: carolId,
      credentialMode: "user",
      connectorType: "mcp",
      operations: []
    });
    expect(await stored("carol-notes")).not.toHaveProperty("availableIn");
  });

  it("refuses mode shared, type http_api, an availability and an accepted tool", async () => {
    expect((await put("carol-shared", own({ credentialMode: "shared" }), carol)).status).toBe(422);
    expect(
      (
        await put(
          "carol-rest",
          own({
            connectorType: "http_api",
            settings: { baseUrl: `${world.sample}/rest` },
            authScheme: "oauth"
          }),
          carol
        )
      ).status
    ).toBe(422);
    expect((await put("carol-everywhere", own(), carol, { availableIn: "all" })).status).toBe(422);
    expect(
      (
        await put(
          "carol-tools",
          own({
            operations: [{ name: "list_customers", effect: "reading", exposure: ["agent"] }]
          }),
          carol
        )
      ).status
    ).toBe(422);
    expect(
      (
        await put(
          "carol-outside",
          own({
            operations: [{ name: "list_customers", effect: "reading", exposure: ["outside"] }]
          }),
          carol
        )
      ).status
    ).toBe(422);
    for (const name of ["carol-shared", "carol-rest", "carol-everywhere", "carol-tools"]) {
      expect(await stored(name)).toBeUndefined();
    }
  });

  it("answers `owner_only_fixed` to a write that changes `ownerOnly`, either way", async () => {
    expect(await put("carol-notes", own({ ownerOnly: false }), carol)).toMatchObject({
      status: 409,
      reason: "owner_only_fixed"
    });
    // A write that leaves it out keeps it.
    const { ownerOnly: _left, ...without } = own({ displayName: "Notes" });
    expect((await put("carol-notes", without, carol)).status).toBe(200);
    expect(await stored("carol-notes")).toMatchObject({ ownerOnly: true, displayName: "Notes" });
    const { ownerOnly: _none, ...personal } = own({ displayName: "Admin's personal server" });
    expect((await put("admin-personal", personal, alice)).status).toBe(200);
    expect(await put("admin-personal", own(), alice)).toMatchObject({
      status: 409,
      reason: "owner_only_fixed"
    });
  });

  it("refuses the create to a key, the CLI, a Service Principal and an embedding host's session", async () => {
    const config = { name: "carol-keyed", ...own() };
    const path = apiOperations["assets.put"].buildPath({
      params: { kind: "connection", name: "carol-keyed" }
    });
    for (const token of [
      await bearerOf(carol, ["account.manage"]),
      await world.embeddedToken(),
      await world.servicePrincipalToken()
    ]) {
      const answer = await request(
        "PUT",
        path,
        { authorization: `Bearer ${token}` },
        { config, expectedRevision: null }
      );
      expect(answer.status, answer.text).toBe(403);
    }
    expect(await stored("carol-keyed")).toBeUndefined();
  });

  it("answers `own_servers_limit` past `perPerson`", async () => {
    expect((await put("carol-second", own(), carol)).status).toBe(200);
    expect(
      (await put("carol-token", own({ settings: { url: `${probe.base}/token/mcp` } }), carol))
        .status
    ).toBe(200);
    expect(await put("carol-fourth", own(), carol)).toMatchObject({
      status: 409,
      reason: "own_servers_limit"
    });
    expect(await stored("carol-fourth")).toBeUndefined();
    // Another person's servers count apart.
    expect(
      (await put("dave-ok", own({ settings: { url: `${probe.base}/ok/mcp` } }), dave)).status
    ).toBe(200);
  });
});

describe("the owner's rights, and nobody else's (check 77)", () => {
  const grantPath = apiOperations["permissions.grant"].buildPath({});

  it("refuses a grant on the server to another person, a Service Principal and a role", async () => {
    const assetId = await world.instance.stores.configAssets
      .getConfigAsset({ clientInstanceId, kind: "connection", name: "carol-notes" })
      .then((row) => row?.id ?? "");
    const daveId = await world.userIdOf(dave);
    const principal = await world.instance.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Notes sync",
      permissions: []
    });
    for (const [holderKind, holderId] of [
      ["user", daveId],
      ["service_principal", principal.id]
    ] as const) {
      // A Service Principal is granted `use` alone on an asset.
      for (const action of holderKind === "user"
        ? ["connection.use", "connection.read"]
        : ["connection.use"]) {
        const answer = await request(
          "POST",
          grantPath,
          { cookie: alice },
          { holderKind, holderId, action, scopeKind: "asset", scopeId: assetId }
        );
        expect(answer, `${holderKind} ${action}`).toMatchObject({
          status: 403,
          reason: "not_owner"
        });
      }
    }
    // A role's grants are written with the role.
    const role = await request(
      "POST",
      apiOperations["roles.create"].buildPath({}),
      { cookie: alice },
      {
        name: "Notes readers",
        grants: [{ action: "connection.use", scopeKind: "asset", scopeId: assetId }]
      }
    );
    expect(role).toMatchObject({ status: 403, reason: "not_owner" });
  });

  it("lets the owner read it, sign in to it, read its tools and change its address and tools", async () => {
    expect((await request("GET", assetPath("carol-notes"), { cookie: carol })).status).toBe(200);
    expect(JSON.parse(await world.detail("carol-notes", carol))).toMatchObject({
      name: "carol-notes"
    });
    const start = await world.start("carol-notes", carol);
    expect(start.status).toBe(200);
    const redirect = await world.authorize(startSchema.parse(start.body).authorizationUrl);
    expect(landingOf((await world.callback(redirect, { cookie: carol })).location).signIn).toBe(
      "connected"
    );
    // CS-9b's discovery exception holds for the owner of a self-added server.
    await world.discover("carol-notes", carol);
    const listed = discoveredSchema.parse(JSON.parse(await world.detail("carol-notes", carol)));
    expect(listed.discovered.map((tool) => tool.name)).toContain("list_customers");
    expect(
      (
        await put(
          "carol-notes",
          own({
            settings: { url: `${world.sample}/registered/mcp` },
            operations: [{ name: "list_customers", effect: "reading", exposure: ["agent"] }]
          }),
          carol
        )
      ).status
    ).toBe(200);
    expect(
      (
        await put(
          "carol-notes",
          own({
            operations: [{ name: "list_customers", effect: "reading", exposure: ["agent"] }]
          }),
          carol
        )
      ).status
    ).toBe(200);
  });

  it("keeps another person out", async () => {
    expect((await request("GET", assetPath("carol-notes"), { cookie: dave })).status).toBe(403);
    expect((await world.start("carol-notes", dave)).status).toBe(403);
    expect((await put("carol-notes", own({ enabled: false }), dave)).status).toBe(403);
    expect((await world.test("carol-notes", dave)).status).toBe(403);
    expect(await world.deleteConnection("carol-notes", dave)).toBe(403);
    const call = await world.call("carol-notes", "list_customers", dave, "agent");
    expect(call.result).toMatchObject({ status: "denied" });
    expect(JSON.stringify(call.result)).toContain("not_owner");
  });

  it("lets an admin read it, switch it off and delete it, and nothing more", async () => {
    expect((await request("GET", assetPath("carol-notes"), { cookie: alice })).status).toBe(200);
    expect(
      await put("carol-notes", own({ settings: { url: `${world.sample}/registered/mcp` } }), alice)
    ).toMatchObject({ status: 403, reason: "not_owner" });
    expect(
      await put(
        "carol-notes",
        own({
          operations: [
            { name: "list_customers", effect: "reading", exposure: ["agent"] },
            { name: "create_customer", effect: "changing", exposure: ["agent"] }
          ]
        }),
        alice
      )
    ).toMatchObject({ status: 403, reason: "not_owner" });
    expect(await world.start("carol-notes", alice)).toMatchObject({ status: 403 });
    for (const answer of [
      await world.test("carol-notes", alice),
      await request(
        "POST",
        apiOperations["connections.discover"].buildPath({ params: { name: "carol-notes" } }),
        { cookie: alice },
        {}
      )
    ]) {
      expect(answer.status).toBe(403);
    }
    expect(await world.setSecret("carol-notes", "a-token", alice)).toBe(403);
    const call = await world.call("carol-notes", "list_customers", alice, "agent");
    expect(JSON.stringify(call.result)).toContain("not_owner");
    // The availability is nobody's to set.
    const availability = await request(
      "PUT",
      apiOperations["assets.set_availability"].buildPath({
        params: { kind: "connection", name: "carol-notes" }
      }),
      { cookie: alice },
      { mode: "all" }
    );
    expect(availability).toMatchObject({ status: 403, reason: "not_owner" });
    // The switch-off: `enabled: false` and nothing else.
    expect(
      await put(
        "carol-notes",
        own({
          enabled: false,
          operations: [{ name: "list_customers", effect: "reading", exposure: ["agent"] }]
        }),
        alice
      )
    ).toEqual({ status: 200, reason: undefined });
    expect(await stored("carol-notes")).toMatchObject({ enabled: false, ownerOnly: true });
    expect(await world.deleteConnection("carol-second", alice)).toBe(200);
    expect(await stored("carol-second")).toBeUndefined();
  });
});

describe("the owner's probe (check 78)", () => {
  it("resolves no credential and answers what the server asks for", async () => {
    expect(await put("carol-probe", own(), carol)).toMatchObject({ status: 200 });
    const signIn = await world.test("carol-probe", carol);
    expect(testSchema.parse(JSON.parse(signIn.text)).status).toBe("oauth_required");
    const before = probe.seen.length;
    const token = await world.test("carol-token", carol);
    expect(testSchema.parse(JSON.parse(token.text)).status).toBe("token_required");
    const ready = await world.test("dave-ok", dave);
    expect(testSchema.parse(JSON.parse(ready.text)).status).toBe("ready");
    expect(probe.seen.slice(before).every((headers) => headers.authorization === undefined)).toBe(
      true
    );
    const state = await world.instance.stores.connections.listConnectionStates({
      clientInstanceId
    });
    const tokenRow = await world.instance.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: "carol-token"
    });
    expect(state.find((row) => row.connectionAssetId === tokenRow?.id)).toMatchObject({
      health: "needs_configuration",
      lastErrorCode: "token_required"
    });
  });

  it("refuses another person's test", async () => {
    expect(await world.test("dave-ok", carol)).toMatchObject({ status: 403 });
  });
});
