import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { captureProcessOutput, dumpDatabaseText, findLeak } from "./support/test-connector";
import {
  REGISTERED_CLIENT_ID,
  callbackPathOf,
  countRows,
  createOAuthWorld,
  landingOf,
  redirectUriOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { withTestSql } from "./support/test-sql";

// CS-4b2, checks 51 and 53 of connections-and-secrets.md: an `mcp` Connection that signs in
// with OAuth, against the demo's sample server and its authorization server, through an
// assembled instance and a person signed in by password. One Connection registers its client
// (DCR), the other uses the client the provider issued. What is asked of the provider is what
// the sample insists on: S256, the exact redirect URI and `resource`.

const startAnswerSchema = z.object({
  authorizationUrl: z.string().url(),
  providerHost: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string()
});
const testAnswerSchema = z.object({ status: z.string() });
const detailSchema = z.object({
  binding: z
    .object({ state: z.string(), scopes: z.array(z.string()), connectedAt: z.string() })
    .optional(),
  oauth: z
    .object({
      registration: z.string(),
      redirectUri: z.string().optional(),
      providerHost: z.string().optional()
    })
    .optional()
});

let world: OAuthWorld;
let output: { stop(): string } | undefined;
const answers: string[] = [];

beforeAll(async () => {
  world = await createOAuthWorld();
}, 60_000);

afterAll(async () => {
  output?.stop();
  await world?.close();
});

async function test(name: string, cookie: string): Promise<string> {
  const { status, text } = await world.test(name, cookie);
  answers.push(text);
  expect(status, text).toBe(200);
  return testAnswerSchema.parse(JSON.parse(text)).status;
}

async function detail(name: string, cookie: string) {
  const text = await world.detail(name, cookie);
  answers.push(text);
  return detailSchema.parse(JSON.parse(text));
}

/** A whole sign-in of `name` by Alice. Answers the start's address and the landing. */
async function signInFully(name: string, cookie: string) {
  const started = await world.start(name, cookie);
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const { authorizationUrl } = startAnswerSchema.parse(started.body);
  const back = await world.authorize(authorizationUrl);
  expect(back.searchParams.get("error")).toBeNull();
  const landed = await world.callback(back, { cookie });
  answers.push(landed.body);
  return { authorizationUrl: new URL(authorizationUrl), back, landed };
}

describe("a shared OAuth sign-in", () => {
  it("tests as oauth_required while nobody signed in, and when the server asks for one", async () => {
    output = captureProcessOutput();
    const alice = await world.signIn("alice");
    expect(await test("dcr", alice)).toBe("oauth_required");
    expect(await test("registered", alice)).toBe("oauth_required");
    expect(await test("keyed", alice)).toBe("oauth_required");
  });

  it("connects by Dynamic Client Registration: S256, resource, one token set, a connected binding", async () => {
    const alice = await world.signIn("alice");
    const { authorizationUrl, landed } = await signInFully("dcr", alice);

    const asked = authorizationUrl.searchParams;
    expect(asked.get("code_challenge_method")).toBe("S256");
    expect(asked.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(asked.get("resource")).toBe(`${world.sample}/dcr/mcp`);
    expect(asked.get("redirect_uri")).toBe(redirectUriOf("dcr"));
    expect(landed.status).toBe(303);
    expect(landingOf(landed.location)).toEqual({ signIn: "connected", connection: "dcr" });

    expect(await test("dcr", alice)).toBe("ready");
    const read = await detail("dcr", alice);
    expect(read.binding).toMatchObject({ state: "connected", scopes: ["sample.read"] });
    expect(read.oauth).toEqual({
      registration: "dcr",
      redirectUri: redirectUriOf("dcr"),
      providerHost: new URL(world.sample).host
    });
    expect(
      await withTestSql(
        (sql) => sql<{ subject: string }[]>`
          select subject from secrets where subject = 'oauth:shared'`
      )
    ).toEqual([{ subject: "oauth:shared" }]);
  });

  it("connects with the client the provider issued and its secret", async () => {
    const alice = await world.signIn("alice");
    const { authorizationUrl, landed } = await signInFully("registered", alice);
    expect(authorizationUrl.searchParams.get("client_id")).toBe(REGISTERED_CLIENT_ID);
    expect(authorizationUrl.searchParams.get("resource")).toBe(`${world.sample}/registered/mcp`);
    expect(landingOf(landed.location)).toEqual({ signIn: "connected", connection: "registered" });
    expect(await test("registered", alice)).toBe("ready");
    expect((await detail("registered", alice)).oauth).toEqual({
      registration: "preregistered",
      redirectUri: redirectUriOf("registered")
    });
    expect(await countRows("connection_bindings")).toBe(2);
  });

  it("records the registration, the sign-ins and nothing secret in audit, runs, logs or the database", async () => {
    const events = await withTestSql(
      (sql) => sql<{ type: string; subject: string | null; status: string }[]>`
        select type, subject, status from audit_events
        where type like 'connection.%' order by created_at`
    );
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "connection.oauth_client_registered", subject: "dcr", status: "success" },
        { type: "connection.binding_connected", subject: "dcr", status: "success" },
        { type: "connection.binding_connected", subject: "registered", status: "success" }
      ])
    );
    const runs = await withTestSql(
      (sql) => sql<{ operation: string; status: string }[]>`
        select operation, status from operation_runs
        where operation like 'connections.oauth_%' order by created_at`
    );
    expect(runs.map((run) => `${run.operation} ${run.status}`)).toEqual([
      "connections.oauth_start done",
      "connections.oauth_complete done",
      "connections.oauth_start done",
      "connections.oauth_complete done"
    ]);

    const logged = output?.stop() ?? "";
    output = undefined;
    // Requests are logged, the callback's never: its address holds the code and the state.
    expect(logged).toContain("/oauth/start");
    expect(logged).not.toContain(callbackPathOf("dcr"));
    expect(logged).not.toContain(callbackPathOf("registered"));
    const database = await dumpDatabaseText();
    const everything = [...world.secrets, world.clientSecret];
    expect(everything.length).toBeGreaterThan(6);
    for (const value of everything) {
      expect(findLeak(logged, value)).toBeUndefined();
      expect(findLeak(database, value)).toBeUndefined();
      expect(findLeak(answers.join("\n"), value)).toBeUndefined();
    }
  });
});
