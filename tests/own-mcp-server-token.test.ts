import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { asClientInstanceId, asUserId } from "@work-shape/catalyst-core";
import {
  createOAuthWorld,
  issuePersonalKey,
  reservePort,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { generateTestSecret } from "./support/test-connector";
import type { TestOperationName } from "./support/operations";
import { withTestSql } from "./support/test-sql";

// A person's own MCP server that takes a pasted token instead of a sign-in (PMCP-6,
// connections acceptance check 83). The token goes to the Secret Store under the person's
// binding (`user:<id>`, scheme `static`), is never answered back, and is sent with a call to
// the server's own origin only, a redirect's target never. A 401 refuses it, Disconnect, the
// Connection's delete, a move of its address or scheme, a deactivation and an admin's revoke
// end it, and nothing of it is left behind or written anywhere a person or an agent reads.

// The token server listens on 127.0.0.1 over plain http, which a person's own server reaches
// only under the operator's rule (PMCP-3); the own rule is tests/own-server-egress.test.ts.
vi.mock("@work-shape/catalyst-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  egressRuleOf: () => "operator"
}));

const clientInstanceId = asClientInstanceId("demo-local");
const PUBLIC_URL = "http://localhost:5173";
const KEY_HEADER = "x-notes-key";
const reasonSchema = z.object({ error: z.object({ details: z.object({ reason: z.string() }) }) });
const ownTokenSchema = z.object({
  state: z.string(),
  scheme: z.string(),
  since: z.string().optional(),
  version: z.number().optional()
});
const detailSchema = z.looseObject({ ownToken: ownTokenSchema.optional() });

/** What reached the token server: by which name, where, and the credential it carried. */
interface Seen {
  host: string;
  path: string;
  authorization: string | undefined;
  key: string | undefined;
}

/**
 * A notes service that takes a token: `/mcp` a Bearer token, `/keyed/mcp` the token under
 * `x-notes-key`, each of the tokens in `accepted`; `/hop/mcp` sends a 307 to the same server
 * by the name `localhost`, another origin, which answers whatever it is sent. Behind it the
 * demo's sample serves the tools.
 */
async function startTokenServer(port: number, behind: () => { sample: string; key: string }) {
  const seen: Seen[] = [];
  const accepted = new Set<string>();
  const server: Server = createServer((request, response) => {
    void (async () => {
      const host = request.headers.host ?? "";
      const path = request.url?.split("?")[0] ?? "";
      const keyHeader = request.headers[KEY_HEADER];
      seen.push({
        host,
        path,
        authorization: request.headers.authorization,
        key: typeof keyHeader === "string" ? keyHeader : undefined
      });
      const body = await readBody(request);
      if (path === "/hop/mcp") {
        response.writeHead(307, { location: `http://localhost:${port}/open/mcp` }).end();
        return;
      }
      if (path === "/mcp" || path === "/keyed/mcp") {
        const token =
          path === "/mcp"
            ? /^Bearer (\S+)$/u.exec(request.headers.authorization ?? "")?.[1]
            : typeof keyHeader === "string"
              ? keyHeader
              : undefined;
        if (token === undefined || !accepted.has(token)) {
          response.writeHead(401, { "content-type": "application/json" }).end("{}");
          return;
        }
      } else if (path !== "/open/mcp") {
        response.writeHead(404).end();
        return;
      }
      const { sample, key } = behind();
      const forwarded: Record<string, string> = { authorization: `Bearer ${key}` };
      for (const name of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"]) {
        const value = request.headers[name];
        if (typeof value === "string") forwarded[name] = value;
      }
      const answer = await fetch(`${sample}/mcp`, {
        method: request.method ?? "POST",
        headers: forwarded,
        ...(body.length === 0 ? {} : { body })
      });
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "mcp-session-id"]) {
        const value = answer.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      response.writeHead(answer.status, headers).end(await answer.text());
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${port}`,
    alias: `http://localhost:${port}`,
    port,
    seen,
    accepted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

let world: OAuthWorld;
let server: Awaited<ReturnType<typeof startTokenServer>>;
let alice: string;
let bob: string;
let carol: string;
let dave: string;
let carolId: string;
/** Every token pasted in this file: none of them may stand anywhere but the Secret Store. */
const pasted: string[] = [];
/** What the instance wrote to its output while this file ran. */
const output: string[] = [];

/** A token as a person pastes it, kept for the checks that it is written nowhere. */
function token(): string {
  const value = generateTestSecret();
  pasted.push(value);
  return value;
}

beforeAll(async () => {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, "write").mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(String(chunk)).toString());
      return Reflect.apply(write, stream, [chunk, ...rest]);
    });
  }
  const port = await reservePort();
  server = await startTokenServer(port, () => ({ sample: world.sample, key: world.sampleKey }));
  world = await createOAuthWorld({
    plainPeople: true,
    ownServers: { enabled: true, perPerson: 10 },
    extraPort: port,
    extraPortAlias: true
  });
  alice = await world.signIn("alice");
  bob = await world.signIn("bob");
  carol = await world.signIn("carol");
  dave = await world.signIn("dave");
  carolId = await world.userIdOf(carol);
}, 90_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await world?.close();
  await server?.close();
});

/** A person's own server at the token server, as the add stores it, and then as changed. */
function own(path: string, overrides: Record<string, unknown> = {}) {
  return {
    connectorType: "mcp",
    credentialMode: "user",
    authScheme: "bearer",
    displayName: "My notes",
    settings: { url: `${server.base}${path}` },
    operations: [],
    enabled: true,
    ownerOnly: true,
    ...overrides
  };
}

const READ = [{ name: "list_customers", effect: "reading", exposure: ["agent"] }];

async function revisionOf(name: string): Promise<number | null> {
  const stored = await world.instance.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "connection",
    name
  });
  return stored?.revision ?? null;
}

/** One operation in the person's browser session: status, refusal reason and text. */
async function api(
  operation: TestOperationName,
  cookie: string,
  input: { params?: Record<string, string>; payload?: Record<string, unknown> } = {},
  headers: Record<string, string> = { cookie, origin: PUBLIC_URL }
) {
  const answer = await world.instance.call(
    operation,
    { params: input.params ?? {}, ...(input.payload ? { payload: input.payload } : {}) },
    { headers }
  );
  return { status: answer.statusCode, reason: reasonOf(answer.body), text: answer.body };
}

function reasonOf(body: string): string | undefined {
  try {
    const parsed = reasonSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.error.details.reason : undefined;
  } catch {
    return undefined;
  }
}

async function put(name: string, config: Record<string, unknown>, cookie: string) {
  return api("assets.put", cookie, {
    params: { kind: "connection", name },
    payload: { config: { name, ...config }, expectedRevision: await revisionOf(name) }
  });
}

async function setToken(
  name: string,
  value: string,
  cookie: string,
  expectedVersion: number | null
) {
  return api("connections.set_own_secret", cookie, {
    params: { name },
    payload: { value, expectedVersion }
  });
}

async function ownToken(name: string, cookie: string) {
  const answer = await api("connections.get", cookie, { params: { name } });
  expect(answer.status, answer.text).toBe(200);
  return detailSchema.parse(JSON.parse(answer.text)).ownToken;
}

/** Adds a server and sets its owner's token: the add, the token, the tools, read again. */
async function addWithToken(name: string, path: string, cookie: string, value: string, extra = {}) {
  expect((await put(name, own(path, extra), cookie)).status).toBe(200);
  expect((await setToken(name, value, cookie, null)).status).toBe(200);
  await world.discover(name, cookie);
  expect((await put(name, own(path, { ...extra, operations: READ }), cookie)).status).toBe(200);
  await world.discover(name, cookie);
}

/** The rows the Secret Store and the bindings hold for a person's own token. */
async function tokenRows(userId: string) {
  return withTestSql(async (sql) => {
    const [secrets] = await sql<{ count: number }[]>`
      select count(*)::int as count from secrets where subject = ${`static:user:${userId}`}`;
    const [bindings] = await sql<{ count: number }[]>`
      select count(*)::int as count from connection_bindings
      where scheme = 'static' and subject = ${`user:${userId}`}`;
    return { secrets: secrets?.count ?? 0, bindings: bindings?.count ?? 0 };
  });
}

const callStatus = async (name: string, cookie: string) =>
  JSON.stringify((await world.call(name, "list_customers", cookie, "agent")).result);

describe("a person's own token (check 83)", () => {
  it("is set write-only by its owner alone, in a first-party session, and rotated over its version", async () => {
    const first = token();
    expect((await put("carol-keyed", own("/mcp"), carol)).status).toBe(200);
    expect(await ownToken("carol-keyed", carol)).toEqual({ state: "not_set", scheme: "bearer" });

    const set = await setToken("carol-keyed", first, carol, null);
    expect(set.status, set.text).toBe(200);
    expect(JSON.parse(set.text)).toEqual({ state: "set", version: 1 });
    expect(await ownToken("carol-keyed", carol)).toMatchObject({
      state: "set",
      scheme: "bearer",
      version: 1
    });
    expect(await tokenRows(carolId)).toEqual({ secrets: 1, bindings: 1 });

    // A stale version is refused and nothing changes.
    expect((await setToken("carol-keyed", token(), carol, null)).status).toBe(409);
    const second = token();
    expect((await setToken("carol-keyed", second, carol, 1)).status).toBe(200);
    expect(await ownToken("carol-keyed", carol)).toMatchObject({ state: "set", version: 2 });

    // Nobody else reaches it: another person, an admin, or the owner's key with every scope.
    expect((await setToken("carol-keyed", token(), dave, null)).status).toBe(403);
    expect((await setToken("carol-keyed", token(), alice, null)).status).toBe(403);
    const byKey = await api(
      "connections.set_own_secret",
      carol,
      { params: { name: "carol-keyed" }, payload: { value: token(), expectedVersion: 2 } },
      { authorization: `Bearer ${await keyOf(carol)}` }
    );
    expect(byKey.status).toBe(403);
    expect(await ownToken("carol-keyed", carol)).toMatchObject({ version: 2 });

    // A server that signs in takes no token.
    expect(
      (
        await put(
          "carol-signs-in",
          own("/mcp", { authScheme: "oauth", settings: { url: `${world.sample}/dcr/mcp` } }),
          carol
        )
      ).status
    ).toBe(200);
    expect(await setToken("carol-signs-in", token(), carol, null)).toMatchObject({
      status: 409,
      reason: "own_secret_unsupported"
    });
  });

  it("goes with each call to its origin alone: as a Bearer token, or under the header it names", async () => {
    const bearer = token();
    server.accepted.add(bearer);
    await addWithToken("carol-bearer", "/mcp", carol, bearer);
    const before = server.seen.length;
    expect(await callStatus("carol-bearer", carol)).toContain('"status":"done"');
    const sent = server.seen.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((seen) => seen.host === `127.0.0.1:${server.port}`)).toBe(true);
    expect(sent.every((seen) => seen.authorization === `Bearer ${bearer}`)).toBe(true);

    const keyed = token();
    server.accepted.add(keyed);
    await addWithToken("carol-header", "/keyed/mcp", carol, keyed, {
      authScheme: "header",
      settings: { url: `${server.base}/keyed/mcp`, headerName: "X-Notes-Key" }
    });
    const from = server.seen.length;
    expect(await callStatus("carol-header", carol)).toContain('"status":"done"');
    const headed = server.seen.slice(from);
    expect(headed.every((seen) => seen.key === keyed && seen.authorization === undefined)).toBe(
      true
    );

    // Another person has no token of their own here, and never Carol's.
    expect(await callStatus("carol-bearer", dave)).not.toContain('"status":"done"');
  });

  it("never goes to another host a redirect names", async () => {
    const value = token();
    server.accepted.add(value);
    expect((await put("carol-hop", own("/hop/mcp"), carol)).status).toBe(200);
    expect((await setToken("carol-hop", value, carol, null)).status).toBe(200);
    await world.discover("carol-hop", carol);
    const redirected = server.seen.filter((seen) => seen.path === "/open/mcp");
    expect(redirected.length).toBeGreaterThan(0);
    expect(redirected.every((seen) => seen.host === `localhost:${server.port}`)).toBe(true);
    expect(redirected.every((seen) => seen.authorization === undefined)).toBe(true);
    expect(redirected.every((seen) => seen.key === undefined)).toBe(true);
    // The redirecting origin itself is sent it: it is the Connection's own.
    expect(
      server.seen.some(
        (seen) => seen.path === "/hop/mcp" && seen.authorization === `Bearer ${value}`
      )
    ).toBe(true);
  });

  it("is refused by a 401: the binding needs a new token, the token is deleted, and the call is not repeated", async () => {
    const value = token();
    server.accepted.add(value);
    await addWithToken("carol-refused", "/mcp", carol, value);
    server.accepted.delete(value);
    const before = server.seen.length;
    expect(await callStatus("carol-refused", carol)).toContain("connection_needs_reconnect");
    const tried = server.seen
      .slice(before)
      .filter((seen) => seen.authorization === `Bearer ${value}`);
    expect(tried).toHaveLength(1);
    expect(await ownToken("carol-refused", carol)).toMatchObject({ state: "needs_reconnect" });
    const assetId = await assetIdOf("carol-refused");
    expect(await secretsOf(assetId, carolId)).toBe(0);
    const refused = (await auditOf("connection.binding_needs_reconnect")).filter(
      (event) => event.subject === "carol-refused"
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.metadata).toMatchObject({
      personal: true,
      scheme: "static",
      userId: carolId
    });

    // The next call never sends anything; a new token over no version is taken.
    const quiet = server.seen.length;
    expect(await callStatus("carol-refused", carol)).toContain("connection_needs_reconnect");
    expect(server.seen.length).toBe(quiet);
    const next = token();
    server.accepted.add(next);
    expect((await setToken("carol-refused", next, carol, null)).status).toBe(200);
    expect(await callStatus("carol-refused", carol)).toContain('"status":"done"');
  });

  it("ends with a move of the address or of the scheme, with Disconnect and with the delete", async () => {
    const value = token();
    server.accepted.add(value);
    await addWithToken("carol-moves", "/mcp", carol, value);
    const assetId = await assetIdOf("carol-moves");
    expect(await secretsOf(assetId, carolId)).toBe(1);

    // Another origin: the same server by another name.
    expect(
      (
        await put(
          "carol-moves",
          own("/mcp", { operations: READ, settings: { url: `${server.alias}/mcp` } }),
          carol
        )
      ).status
    ).toBe(200);
    expect(await ownToken("carol-moves", carol)).toMatchObject({ state: "not_set" });
    expect(await secretsOf(assetId, carolId)).toBe(0);

    // Another scheme, at the same address.
    expect((await put("carol-moves", own("/mcp", { operations: READ }), carol)).status).toBe(200);
    expect((await setToken("carol-moves", value, carol, null)).status).toBe(200);
    expect(
      (
        await put(
          "carol-moves",
          own("/mcp", {
            operations: READ,
            authScheme: "header",
            settings: { url: `${server.base}/mcp`, headerName: "X-Notes-Key" }
          }),
          carol
        )
      ).status
    ).toBe(200);
    expect(await ownToken("carol-moves", carol)).toMatchObject({
      state: "not_set",
      scheme: "header"
    });
    expect(await secretsOf(assetId, carolId)).toBe(0);

    // Disconnect deletes it; no provider is told, there is none.
    expect((await setToken("carol-moves", value, carol, null)).status).toBe(200);
    const disconnected = await world.disconnect("carol-moves", carol);
    expect(disconnected).toMatchObject({
      status: 200,
      body: { state: "revoked", providerRevocation: "not_offered" }
    });
    expect(await secretsOf(assetId, carolId)).toBe(0);
    expect(await ownToken("carol-moves", carol)).toMatchObject({ state: "not_set" });

    // The delete leaves nothing behind.
    expect((await setToken("carol-moves", value, carol, null)).status).toBe(200);
    expect(await world.deleteConnection("carol-moves", carol)).toBe(200);
    expect(await secretsOf(assetId, carolId)).toBe(0);
    expect(await bindingsOf(assetId)).toBe(0);
  });

  it("on an admin's personal server is each person's own: revoked by an admin, ended by a deactivation", async () => {
    const aliceToken = token();
    const bobToken = token();
    server.accepted.add(aliceToken);
    server.accepted.add(bobToken);
    expect(
      (
        await put(
          "team-notes",
          {
            connectorType: "mcp",
            credentialMode: "user",
            authScheme: "bearer",
            displayName: "Team notes",
            settings: { url: `${server.base}/mcp` },
            operations: READ,
            enabled: true
          },
          alice
        )
      ).status
    ).toBe(200);
    expect((await setToken("team-notes", aliceToken, alice, null)).status).toBe(200);
    // An embedding host's session is no first-party person's, admin or not.
    const embedded = await api(
      "connections.set_own_secret",
      alice,
      { params: { name: "team-notes" }, payload: { value: token(), expectedVersion: null } },
      { authorization: `Bearer ${await world.embeddedToken()}` }
    );
    expect(embedded.status).toBe(403);
    // Nor is a Service Principal's, whose key writes config assets.
    const service = await api(
      "connections.set_own_secret",
      alice,
      { params: { name: "team-notes" }, payload: { value: token(), expectedVersion: null } },
      { authorization: `Bearer ${await world.servicePrincipalToken()}` }
    );
    expect(service.status).toBe(403);
    // Its tools are read with Alice's token, who set it up.
    await world.discover("team-notes", alice);
    // Bob has none yet: his call is refused, and never made with Alice's.
    const before = server.seen.length;
    expect(await callStatus("team-notes", bob)).toContain("connection_not_connected");
    expect(server.seen.length).toBe(before);
    expect((await setToken("team-notes", bobToken, bob, null)).status).toBe(200);
    const from = server.seen.length;
    expect(await callStatus("team-notes", bob)).toContain('"status":"done"');
    expect(
      server.seen.slice(from).every((seen) => seen.authorization === `Bearer ${bobToken}`)
    ).toBe(true);

    // The People list shows who set one, and an admin's revoke ends Bob's alone.
    const people = await api("connections.people", alice, { params: { name: "team-notes" } });
    expect(people.status).toBe(200);
    const bobId = await world.userIdOf(bob);
    const revoked = await api("connections.revoke_person", alice, {
      params: { name: "team-notes", userId: bobId }
    });
    expect(revoked.status, revoked.text).toBe(200);
    const assetId = await assetIdOf("team-notes");
    expect(await secretsOf(assetId, bobId)).toBe(0);
    expect(await secretsOf(assetId, await world.userIdOf(alice))).toBe(1);

    // Dave's deactivation ends his token on his own server.
    const daveId = await world.userIdOf(dave);
    const daveToken = token();
    expect((await put("dave-notes", own("/mcp"), dave)).status).toBe(200);
    expect((await setToken("dave-notes", daveToken, dave, null)).status).toBe(200);
    expect(await tokenRows(daveId)).toEqual({ secrets: 1, bindings: 1 });
    await world.instance.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(daveId),
      status: "disabled"
    });
    expect(await tokenRows(daveId)).toEqual({ secrets: 0, bindings: 0 });
    const ended = (await auditOf("connection.binding_revoked")).filter(
      (event) => event.metadata?.userId === daveId
    );
    expect(ended.length).toBeGreaterThan(0);
  });

  it("stands nowhere but the Secret Store, encrypted: no answer, audit record, run, row or log line", async () => {
    expect(pasted.length).toBeGreaterThan(5);
    const answers = [
      await api("connections.mine", carol),
      await api("connections.get", carol, { params: { name: "carol-bearer" } }),
      await api("connections.people", alice, { params: { name: "team-notes" } })
    ];
    const rows = await storedRows();
    const audit = JSON.stringify(
      await world.instance.stores.audit.listAuditEvents({
        clientInstanceId,
        limit: 1000
      })
    );
    for (const value of pasted) {
      for (const answer of answers) expect(answer.text).not.toContain(value);
      expect(audit).not.toContain(value);
      expect(rows.filter((row) => row.text.includes(value)).map((row) => row.table)).toEqual([]);
      expect(output.some((line) => line.includes(value))).toBe(false);
    }
  });
});

/** An access token of the person's personal key, as the CLI holds one. */
async function keyOf(cookie: string): Promise<string> {
  const issued = await issuePersonalKey(world, cookie, {
    name: "Key",
    scopes: ["account.manage"],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString()
  });
  const secret = z.object({ secret: z.string() }).parse(await issued.json()).secret;
  const exchanged = await fetch(
    `${world.api}${apiOperations["access_tokens.exchange"].buildPath({})}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` }
    }
  );
  return z.object({ accessToken: z.string() }).parse(await exchanged.json()).accessToken;
}

async function assetIdOf(name: string): Promise<string> {
  const stored = await world.instance.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "connection",
    name
  });
  if (!stored) throw new Error(`No Connection ${name}`);
  return stored.id;
}

async function secretsOf(connectionAssetId: string, userId: string): Promise<number> {
  return withTestSql(async (sql) => {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from secrets
      where connection_asset_id = ${connectionAssetId} and subject = ${`static:user:${userId}`}`;
    return row?.count ?? 0;
  });
}

async function bindingsOf(connectionAssetId: string): Promise<number> {
  return withTestSql(async (sql) => {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from connection_bindings
      where connection_asset_id = ${connectionAssetId}`;
    return row?.count ?? 0;
  });
}

async function auditOf(type: string) {
  return (
    await world.instance.stores.audit.listAuditEvents({ clientInstanceId, limit: 1000 })
  ).filter((event) => event.type === type);
}

/** Every row of every table, as the text Postgres holds: the ciphertext is bytes, never text. */
async function storedRows(): Promise<{ table: string; text: string }[]> {
  return withTestSql(async (sql) => {
    const tables = await sql<{ schema: string; name: string }[]>`
      select table_schema as schema, table_name as name from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema = current_schema()`;
    const rows: { table: string; text: string }[] = [];
    for (const { schema, name } of tables) {
      const found = await sql.unsafe<{ text: string }[]>(
        `select row_to_json(t)::text as text from "${schema}"."${name}" t`
      );
      rows.push(...found.map(({ text }) => ({ table: name, text })));
    }
    return rows;
  });
}
