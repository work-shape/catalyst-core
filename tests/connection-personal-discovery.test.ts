import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { z } from "zod";
import {
  asClientInstanceId,
  requirePersonalDiscoveryContext,
  type AuthenticatedUser,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import { requestConnectionDiscovery } from "@work-shape/catalyst-server";
import {
  createOAuthWorld,
  issuePersonalKey,
  landingOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { getTestJobs } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// The one exception to CS-9b's owner-only agent call (manager ruling, 2026-10-30): the owner of
// a personal MCP Connection reads its tool list with their own sign-in, from its create or
// settings path. Another person, a key, a session an embedding host issued, a Service
// Principal, an agent, an App and a Workflow stay refused, and so does every tool call outside
// the owner's allowed chat.

const instanceId = asClientInstanceId("demo-local");
const NAME = "own-mcp";
const startSchema = z.object({ authorizationUrl: z.string() });
const detailSchema = z.object({
  discovered: z.array(z.object({ name: z.string() })),
  discoveredAt: z.string().optional()
});
const refusalSchema = z.object({ error: z.object({ details: z.object({ reason: z.string() }) }) });

let world: OAuthWorld;
let alice: string;
let bob: string;

beforeAll(async () => {
  world = await createOAuthWorld();
  alice = await world.signIn("alice");
  bob = await world.signIn("bob");
  expect(await world.putConnection(NAME, definition([]), alice)).toBe(200);
  for (const cookie of [alice, bob]) {
    const start = await world.start(NAME, cookie);
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const redirect = await world.authorize(startSchema.parse(start.body).authorizationUrl);
    expect(landingOf((await world.callback(redirect, { cookie })).location).signIn).toBe(
      "connected"
    );
  }
}, 60_000);
afterAll(async () => {
  await world?.close();
});

/** Alice's personal MCP Connection on the sample, with the operations it accepts. */
function definition(operations: Record<string, unknown>[]) {
  return {
    credentialMode: "user",
    authScheme: "oauth",
    connectorType: "mcp",
    displayName: "Own MCP",
    settings: { url: `${world.sample}/dcr/mcp` },
    operations,
    enabled: true
  };
}

async function detail(cookie: string) {
  return detailSchema.parse(JSON.parse(await world.detail(NAME, cookie)));
}

/** `connections.discover` with the given headers: its status and refusal reason. */
async function discoverWith(headers: Record<string, string>) {
  const response = await fetch(
    `${world.api}${apiOperations["connections.discover"].buildPath({ params: { name: NAME } })}`,
    {
      method: "POST",
      headers: { origin: "http://localhost:5173", "content-type": "application/json", ...headers },
      body: "{}"
    }
  );
  const body: unknown = await response.json();
  const parsed = refusalSchema.safeParse(body);
  return {
    status: response.status,
    reason: parsed.success ? parsed.data.error.details.reason : ""
  };
}

async function accessToken(secret: string): Promise<string> {
  const response = await fetch(
    `${world.api}${apiOperations["access_tokens.exchange"].buildPath({})}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` }
    }
  );
  const answer = z.object({ accessToken: z.string() }).parse(await response.json());
  return answer.accessToken;
}

async function discoveryJobs() {
  return withTestSql(
    (sql) => sql<{ status: string; payload: Record<string, unknown> }[]>`
      select status, payload from platform_jobs
      where kind = 'connection.discover' and subject = ${NAME}`
  );
}

describe("the owner's own discovery of a personal MCP Connection (CS-9b exception)", () => {
  it("reads the tools with the owner's sign-in; only the owner sees them, and it is audited without content", async () => {
    // Saving it queued no discovery: nothing opens a person's grant in the background.
    expect(await discoveryJobs()).toEqual([]);
    await world.discover(NAME, alice);
    const own = await detail(alice);
    expect(own.discovered.map((tool) => tool.name)).toContain("list_customers");
    expect(own.discoveredAt).toBeDefined();
    const jobs = await discoveryJobs();
    expect(jobs.map((job) => job.payload)).toEqual([
      { connectionName: NAME, personalOwner: await world.userIdOf(alice) }
    ]);

    // Bob may read the Connection, and signed in to it himself: the list is not his to see.
    const other = await detail(bob);
    expect(other.discovered).toEqual([]);
    expect(other.discoveredAt).toBeUndefined();

    const [event] = await withTestSql(
      (sql) => sql<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit_events
        where type = 'connection.discovered' and subject = ${NAME}`
    );
    expect(event?.metadata).toMatchObject({ connectionName: NAME, personal: true });
    expect(JSON.stringify(event?.metadata)).not.toContain("list_customers");

    // A discovery marks no conversation.
    const [marked] = await withTestSql(
      (sql) => sql<{ count: number }[]>`
        select count(*)::int as count from conversations where personal_data_at is not null`
    );
    expect(marked?.count).toBe(0);
  });

  it("refuses another person, a personal key, an embedding host's session and a Service Principal", async () => {
    expect(await discoverWith({ cookie: bob })).toEqual({
      status: 403,
      reason: "personal_connection_context"
    });
    const issued = await issuePersonalKey(world, alice, {
      name: "Terminal",
      scopes: ["connection.read", "connection.write"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    });
    const key = z.object({ secret: z.string() }).parse(await issued.json()).secret;
    expect(await discoverWith({ authorization: `Bearer ${await accessToken(key)}` })).toEqual({
      status: 403,
      reason: "personal_connection_context"
    });
    expect(
      await discoverWith({ authorization: `Bearer ${await world.embeddedToken()}` })
    ).toMatchObject({ status: 403 });
    expect(
      await discoverWith({ authorization: `Bearer ${await world.servicePrincipalToken()}` })
    ).toMatchObject({ status: 403 });
    // Nothing of theirs was queued.
    expect(await discoveryJobs()).toHaveLength(1);
  });

  it("refuses a delegated actor, an agent, an App and a Workflow, and an MCP-less or foreign Connection", async () => {
    const owner = await world.identityOf(alice);
    const person: AuthenticatedUser = { ...owner, authenticationMethod: "session-cookie" };
    const connection = { connectorType: "mcp", ownerPrincipalId: owner.id };
    const admit =
      (actor: AuthenticatedUser, origin: OperationOrigin, of = connection) =>
      () =>
        requirePersonalDiscoveryContext({ actor, origin, connection: of });
    expect(admit(person, { kind: "user" })()).toBe(owner.id);
    const refused: (() => string)[] = [
      admit(
        {
          ...person,
          delegatedActor: { kind: "service_principal", id: "sp_1", authSource: "test" }
        },
        { kind: "user" }
      ),
      admit({ ...person, keyScopes: ["connection.write"] }, { kind: "user" }),
      admit({ ...owner }, { kind: "user" }),
      admit({ ...person, subjectUserId: "someone-else" }, { kind: "user" }),
      admit(person, { kind: "workflow", workflowRunId: "wfr_1", stepRunId: "wfs_1" }),
      admit(person, { kind: "schedule", scheduleId: "sch_1" }),
      admit(person, { kind: "cli" }),
      admit(person, {
        kind: "app",
        appRevisionId: "rev_1",
        actionName: "read",
        pageSessionId: "page_1"
      }),
      admit(person, { kind: "user" }, { connectorType: "http_api", ownerPrincipalId: owner.id }),
      admit(person, { kind: "user" }, { connectorType: "mcp", ownerPrincipalId: "someone-else" })
    ];
    for (const attempt of refused) {
      expect(attempt).toThrowError(
        expect.objectContaining({ details: { reason: "personal_connection_context" } })
      );
    }
  });

  it("refuses a discovery queued without its owner and contacts nothing", async () => {
    const before = await detail(alice);
    await requestConnectionDiscovery(world.instance.stores.jobs, {
      clientInstanceId: instanceId,
      connectionName: NAME
    });
    await getTestJobs(world.instance).runDue();
    const ownerless = (await discoveryJobs()).filter(
      (job) => job.payload.personalOwner === undefined
    );
    expect(ownerless.map((job) => job.status)).toEqual(["failed"]);
    // What the owner's discovery stored stays.
    expect((await detail(alice)).discoveredAt).toBe(before.discoveredAt);
  });

  it("still refuses its test, and every tool call outside the owner's allowed chat", async () => {
    const test = await world.test(NAME, alice);
    expect(test.status).toBe(403);
    expect(test.text).toContain("personal_connection_context");
    expect(
      await world.putConnection(
        NAME,
        definition([
          { name: "list_customers", effect: "reading", enabled: true, exposure: ["agent"] }
        ]),
        alice
      )
    ).toBe(200);
    // The settings path reads the tools again for the accepted list.
    await world.discover(NAME, alice);
    const outside = await world.call(NAME, "list_customers", alice, "cli");
    expect(outside.result).toMatchObject({
      status: "failed",
      error: { details: { reason: "personal_connection_context" } }
    });
    // The owner's agent in their own chat calls it: the exception changed nothing there.
    expect((await world.call(NAME, "list_customers", alice, "agent")).result.status).toBe("done");
  });
});
