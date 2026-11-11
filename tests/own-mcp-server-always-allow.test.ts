import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AppError,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  createPlatformId,
  unknownToJsonValue,
  type AgentRun,
  type AuthenticatedUser
} from "@work-shape/catalyst-core";
import { setOwnOperationSetting } from "@work-shape/catalyst-server";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { waitUntil } from "./support/assertions";
import { createOAuthWorld, landingOf, type OAuthWorld } from "./support/oauth-sign-in-world";

// The sample serves plain http on 127.0.0.1, which a person's own server reaches only under the
// operator's rule (PMCP-3); this file is about how its changing tools ask.
vi.mock("@work-shape/catalyst-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  egressRuleOf: () => "operator"
}));

// PMCP-4b, end to end (connections acceptance check 85): Carol answers a changing tool of her own
// server with "Always allow". Its next call in a chat where only that server ran goes without
// asking, while another changing tool still asks; in a chat where another Connection ran it asks
// again. Only Carol sets it, in her own signed-in session. Ask me takes it back, and a discovery
// that finds the tool changed removes it in its write, so the next call asks.

const clientInstanceId = asClientInstanceId("demo-local");
const PUBLIC_URL = "http://localhost:5173";
const SERVER = "carol-notes";
const CHANGE = `connection.${SERVER}.list_orders`;
const OTHER_CHANGE = `connection.${SERVER}.list_invoices`;
const startSchema = z.object({ authorizationUrl: z.string() });
const runIdSchema = z.object({ run: z.object({ id: z.string() }) });

let world: OAuthWorld;
let carol: string;
let dave: string;
let carolId: string;

function own(operations: unknown[]) {
  return {
    name: SERVER,
    connectorType: "mcp",
    credentialMode: "user",
    authScheme: "oauth",
    displayName: "My notes",
    settings: { url: `${world.sample}/dcr/mcp` },
    operations,
    enabled: true,
    ownerOnly: true
  };
}

/** What Carol accepted: one reading and two changing tools. */
const accepted = (listOrders: Record<string, unknown> = {}) => [
  { name: "list_customers", effect: "reading", exposure: ["agent"] },
  { name: "list_orders", effect: "changing", exposure: ["agent"], ...listOrders },
  { name: "list_invoices", effect: "changing", exposure: ["agent"] }
];

async function putOwn(operations: unknown[]) {
  const stored = await world.instance.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "connection",
    name: SERVER
  });
  const answer = await world.instance.call(
    "assets.put",
    {
      params: { kind: "connection", name: SERVER },
      payload: { config: own(operations), expectedRevision: stored?.revision ?? null }
    },
    { headers: { cookie: carol, origin: PUBLIC_URL } }
  );
  expect(answer.statusCode, answer.body).toBe(200);
}

beforeAll(async () => {
  world = await createOAuthWorld({
    plainPeople: true,
    ownServers: { enabled: true, perPerson: 3 }
  });
  carol = await world.signIn("carol");
  dave = await world.signIn("dave");
  carolId = await world.userIdOf(carol);
  await putOwn([]);
  const started = await world.start(SERVER, carol);
  expect(started.status).toBe(200);
  const back = await world.authorize(startSchema.parse(started.body).authorizationUrl);
  expect(landingOf((await world.callback(back, { cookie: carol })).location).signIn).toBe(
    "connected"
  );
  await world.discover(SERVER, carol);
  await putOwn(accepted());
  await world.discover(SERVER, carol);
  await applyAtCurrentRevisions(world.instance.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "agent",
        name: "test_agent",
        config: {
          name: "test_agent",
          displayName: "Test Agent",
          instructions: "Follow the tool commands.",
          modelProviderId: "local",
          toolNames: []
        }
      },
      { type: "setDefaultAgent", agentName: "test_agent" }
    ]
  });
}, 90_000);
afterAll(async () => {
  await world?.close();
});

const runOf = async (runId: string): Promise<AgentRun> => {
  const run = await world.instance.stores.agentRuns.getAgentRun({
    clientInstanceId,
    runId: asAgentRunId(runId)
  });
  if (!run) throw new Error(`No run ${runId}`);
  return run;
};

const callsOf = async (runId: string) =>
  (await world.instance.stores.operationRuns.list({ clientInstanceId })).filter(
    (run) => run.origin.kind === "agent" && run.origin.agentRunId === runId
  );

async function newChat(cookie: string): Promise<string> {
  const created = await world.instance.call(
    "conversations.create",
    { payload: { title: "Notes", visibility: "private" } },
    { headers: { cookie, origin: PUBLIC_URL } }
  );
  expect(created.statusCode, created.body).toBe(200);
  return z.object({ id: z.string() }).parse(created.json()).id;
}

/** Carol's agent calls one tool, in a new private chat of hers or in `conversationId`. */
async function call(tool: string, conversationId?: string) {
  const chat = conversationId ?? (await newChat(carol));
  const started = await world.instance.call(
    "conversations.runs.start",
    {
      params: { conversationId: chat },
      payload: {
        idempotencyKey: createPlatformId("start"),
        agentName: "test_agent",
        message: { text: `/tool ${tool} {}` }
      }
    },
    { headers: { cookie: carol, origin: PUBLIC_URL } }
  );
  expect(started.statusCode, started.body).toBe(200);
  const runId = runIdSchema.parse(started.json()).run.id;
  await waitUntil(
    async () =>
      ["waiting_for_decision", "completed", "failed"].includes((await runOf(runId)).status),
    "the run waits or ended"
  );
  const [operationRun, ...rest] = await callsOf(runId);
  expect(rest).toEqual([]);
  if (!operationRun) throw new Error("The run made no call");
  return { runId, operationRun, status: (await runOf(runId)).status };
}

const settingOf = (operation: string) =>
  world.instance.stores.userOperationSettings.get({
    clientInstanceId,
    userId: carolId,
    operation
  });

const settingEvents = async () =>
  (
    await world.instance.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "user.operation_setting_changed"
    })
  ).map((event) => ({ reason: event.reason, subject: event.subject, metadata: event.metadata }));

async function setOwn(headers: Record<string, string>, value: string | null) {
  return world.instance.call(
    "me.operation_settings.set",
    { payload: { operation: CHANGE, value } },
    { headers: { origin: PUBLIC_URL, ...headers } }
  );
}

describe("Always allow for a changing tool of a person's own server", () => {
  it("lets the owner's next call of that tool run, while another changing tool still asks", async () => {
    const asked = await call(CHANGE);
    expect(asked.status).toBe("waiting_for_decision");
    expect(asked.operationRun).toMatchObject({
      status: "pending_confirmation",
      offersAlwaysAllow: true
    });
    const decided = await world.instance.call(
      "operations.decide",
      {
        params: { runId: asked.operationRun.id },
        payload: { decision: "confirm", alwaysAllow: true }
      },
      { headers: { cookie: carol, origin: PUBLIC_URL } }
    );
    expect(decided.statusCode, decided.body).toBe(200);
    expect(await settingOf(CHANGE)).toBe("always_allow");
    expect(await settingEvents()).toContainEqual({
      reason: undefined,
      subject: carolId,
      metadata: expect.objectContaining({ operation: CHANGE, value: "always_allow" })
    });

    const next = await call(CHANGE);
    expect(next.status).toBe("completed");
    expect(next.operationRun).toMatchObject({ operation: CHANGE, status: "done" });
    expect(next.operationRun.decision).toBeUndefined();

    const other = await call(OTHER_CHANGE);
    expect(other.status).toBe("waiting_for_decision");
    expect(other.operationRun).toMatchObject({ status: "pending_confirmation" });
  });

  it("asks again in a chat where another Connection's operation ran, and offers no Always allow there", async () => {
    const chat = asConversationId(await newChat(carol));
    const now = new Date().toISOString();
    const ran = await world.instance.stores.operationRuns.create({
      id: createPlatformId("oprun"),
      clientInstanceId,
      operation: "connection.shared-crm.search",
      effect: "reading",
      actor: { kind: "user", id: carolId, label: "Carol" },
      origin: { kind: "user" },
      conversationId: chat,
      target: "live",
      inputHash: createPlatformId("hash"),
      correlationId: "corr_cross_source",
      startedAt: now
    });
    if (!ran) throw new Error("No run was created");
    await world.instance.stores.operationRuns.finish({
      clientInstanceId,
      id: ran.id,
      end: { status: "done", finishedAt: now }
    });

    const asked = await call(CHANGE, chat);
    expect(asked.status).toBe("waiting_for_decision");
    expect(asked.operationRun.status).toBe("pending_confirmation");
    expect(asked.operationRun.offersAlwaysAllow).toBeUndefined();
    expect(await settingOf(CHANGE)).toBe("always_allow");
  });

  it("is set by its owner alone, in their own signed-in session: user_only otherwise", async () => {
    const carolIs = await world.identityOf(carol);
    const signedIn: AuthenticatedUser = { ...carolIs, authenticationMethod: "session-cookie" };
    const { registry, policy } = (await world.calls()).deps;
    const deps = { clientInstanceId, stores: world.instance.stores, registry, policy };
    const set = async (
      actor: AuthenticatedUser,
      value: "always_allow" | "ask" = "always_allow"
    ) => {
      try {
        await setOwnOperationSetting(deps, { actor, operation: CHANGE, value });
        return "set";
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return z.object({ reason: z.string() }).parse(error.details).reason;
      }
    };
    const key = {
      kind: "api_key" as const,
      id: createPlatformId<"ApiCredentialId">("key"),
      displayLabel: "Key",
      authSource: "test"
    };
    // Her personal key, the CLI's token (no browser session) and an embedding host's session.
    expect(await set({ ...signedIn, delegatedActor: key, keyScopes: ["*"] })).toBe("user_only");
    expect(await set(carolIs)).toBe("user_only");
    expect(
      await set({
        ...signedIn,
        delegatedActor: { kind: "service_principal", id: "sp_host", authSource: "test" }
      })
    ).toBe("user_only");
    // Somebody else's server is no operation of Dave's.
    expect(
      await set({ ...(await world.identityOf(dave)), authenticationMethod: "session-cookie" })
    ).toBe("unknown_operation");
    expect(await set(signedIn)).toBe("set");

    // An embedding host's token and a Service Principal are refused by the route as well.
    for (const token of [await world.embeddedToken(), await world.servicePrincipalToken()]) {
      const refused = await setOwn({ authorization: `Bearer ${token}` }, "always_allow");
      expect(refused.statusCode, refused.body).toBe(403);
    }
    const daveAnswer = await setOwn({ cookie: dave }, "always_allow");
    expect(daveAnswer.statusCode).toBe(422);
    expect(daveAnswer.body).toContain("unknown_operation");
    expect(await settingOf(CHANGE)).toBe("always_allow");
  });

  it("is taken back with Ask me on Settings > You > Confirmations", async () => {
    const listed = await world.instance.call(
      "me.operation_settings.list",
      {},
      { headers: { cookie: carol, origin: PUBLIC_URL } }
    );
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      z
        .object({ items: z.array(z.object({ operation: z.string() }).passthrough()) })
        .parse(listed.json())
        .items.find((item) => item.operation === CHANGE)
    ).toMatchObject({ value: "always_allow", mayAlwaysAllow: true, effect: "changing" });

    const askMe = await setOwn({ cookie: carol }, "ask");
    expect(askMe.statusCode, askMe.body).toBe(200);
    expect((await call(CHANGE)).status).toBe("waiting_for_decision");

    const again = await setOwn({ cookie: carol }, "always_allow");
    expect(again.statusCode, again.body).toBe(200);
    expect((await call(CHANGE)).status).toBe("completed");
  });

  it("is removed when a discovery finds the tool changed, so the next call asks", async () => {
    const asset = await world.instance.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: SERVER
    });
    if (!asset) throw new Error("No server");
    const catalogSchema = z
      .object({
        pinned: z.record(z.string(), z.string()),
        entries: z.array(z.object({ name: z.string(), fingerprint: z.string() }).passthrough())
      })
      .passthrough();
    const stateOf = async () => {
      const state = await world.instance.stores.connections.getConnectionState({
        clientInstanceId,
        connectionAssetId: asset.id
      });
      if (!state) throw new Error("No state");
      return { state, catalog: catalogSchema.parse(state.catalog) };
    };
    // What Carol accepted read otherwise than the server describes the tool now, as after the
    // server changed its description.
    const { state, catalog } = await stateOf();
    await world.instance.stores.connections.putConnectionState({
      clientInstanceId,
      connectionAssetId: asset.id,
      health: state.health,
      catalog: unknownToJsonValue({
        ...catalog,
        pinned: { ...catalog.pinned, list_orders: "0".repeat(64) }
      })
    });
    await world.instance.stores.userOperationSettings.set({
      clientInstanceId,
      userId: carolId,
      operation: OTHER_CHANGE,
      value: "never",
      at: new Date().toISOString()
    });
    await world.discover(SERVER, carol);

    expect(await settingOf(CHANGE)).toBeUndefined();
    // Only Always allow goes, and only of the tool that changed.
    expect(await settingOf(OTHER_CHANGE)).toBe("never");
    const removed = (await settingEvents()).filter((event) => event.reason === "tool_changed");
    expect(removed).toEqual([
      {
        reason: "tool_changed",
        subject: carolId,
        metadata: { operation: CHANGE, value: "default" }
      }
    ]);

    // Carol accepts the tool as it reads now; its next call asks.
    const now = (await stateOf()).catalog.entries.find((entry) => entry.name === "list_orders");
    if (!now) throw new Error("No list_orders");
    await putOwn(accepted({ schemaFingerprint: now.fingerprint }));
    await world.discover(SERVER, carol);
    expect((await call(CHANGE)).status).toBe("waiting_for_decision");
    expect(await settingOf(CHANGE)).toBeUndefined();
  });
});
