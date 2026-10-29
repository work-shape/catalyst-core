import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CompositeAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  IdentityResolvingAuthAdapter,
  type AuthAdapter
} from "@work-shape/catalyst-auth";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  asUserId,
  CHAT_SESSION_AUTH_SCOPES,
  isAuthenticatedServicePrincipal,
  PLATFORM_EVENT_ALLOW,
  type AgentRuntime,
  type AuthenticatedUser,
  type OperationDefinition,
  type UserStore
} from "@work-shape/catalyst-core";
import { resolveGuardedPolicy } from "@work-shape/catalyst-tool-execution";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  agent,
  clientInstanceId,
  recordAuthAdapter,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// An embedding host's token reaches what the person may use in shared places, never what is
// theirs alone: their own agent, their confirmations, a Data Store added by their own click
// and their account. The host mints a token for any person with one credential, so even a
// token signed without a delegated actor is the host acting for them. Each check is paired
// with the same person in their own browser session, which still reaches it.

const OWN = "kai-tax";
const tokenOptions = {
  secret: "embed-host-personal-reach-secret-long-enough",
  clientInstanceId,
  issuer: "embedding-host",
  ttlSeconds: 900
};
const HOST_USER = "kai-at-host";

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

const refuse = (): never => {
  throw new Error("Not used here");
};
/** Takes every run the start service prepared, without running it. */
const queuedRuntime: AgentRuntime = {
  async start(input) {
    const prepared = input.preparedRun ?? refuse();
    return { runId: prepared.id, status: "queued", startedAt: prepared.startedAt };
  },
  observe: () => refuse(),
  getStatus: async () => refuse(),
  resume: async () => refuse(),
  cancel: async () => refuse()
};

/** The person's own sign-in, as the standalone auth marks a browser session cookie. */
function browserSession(): AuthAdapter {
  const record = recordAuthAdapter();
  return {
    id: "browser-session",
    credentialMode: "ambient",
    async authenticate(request) {
      const identity = await record.authenticate(request);
      return { ...identity, authenticationMethod: "session-cookie", sessionId: "ses_kai" };
    }
  };
}

/** Kai signs in himself and is embedded by a host whose token maps onto the same person. */
async function setup() {
  const signIn = (users: UserStore): AuthAdapter =>
    new CompositeAuthAdapter([
      browserSession(),
      new IdentityResolvingAuthAdapter(new HmacSessionTokenAuthAdapter(tokenOptions), users)
    ]);
  const t = await setupAccessInstance({
    storedAssetSource: true,
    modules: { dataStores: { enabled: true } },
    server: (stores) => ({ agentRuntime: queuedRuntime, authAdapter: signIn(stores.users) })
  });
  instances.push(t);
  const authAdapter = signIn(t.stores.users);
  const kai = asUserId(t.kai.id);
  // Identity linking: the host's id for Kai is the same product user as his own sign-in.
  await t.stores.users.upsertUserIdentity({
    clientInstanceId,
    userId: kai,
    authSource: "session-token",
    externalUserId: HOST_USER
  });
  const home = (
    await t.stores.workspaces.ensurePersonalWorkspace({ clientInstanceId, userId: kai })
  ).id;
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    initialAgentAvailability: "hidden",
    mutations: [
      {
        type: "upsert",
        kind: "agent",
        name: OWN,
        config: agent(OWN, { displayName: "Kais Steuer" }),
        scope: { kind: "workspace", workspaceId: home }
      }
    ]
  });
  // A token the host signed without naming itself as the delegated actor.
  const { chatSessionToken } = new HmacSessionTokenIssuer(tokenOptions).issue({
    externalUserId: HOST_USER,
    displayLabel: "Kai"
  });
  const embed = { authorization: `Bearer ${chatSessionToken}` };
  // The interface's own requests: a changing one comes from the same origin.
  const own = { "sec-fetch-site": "same-origin" };
  const chat = async () =>
    z.object({ id: z.string() }).parse(
      (
        await t.expectOk(t.kai.id, "conversations.create", {
          payload: { title: "Own", collaborationWorkspaceId: home },
          headers: own
        })
      ).json()
    ).id;
  return {
    t,
    home,
    chat,
    embed,
    own,
    /** Who the server takes the request for: Kai, never a service principal. */
    authenticate: async (headers: Record<string, string>): Promise<AuthenticatedUser> => {
      const identity = await authAdapter.authenticate({
        headers: { ...headers, "x-test-user": t.kai.id },
        clientInstanceId,
        correlationId: "corr_embed"
      });
      if (isAuthenticatedServicePrincipal(identity)) throw new Error("Not a person");
      return identity;
    }
  };
}

const errorSchema = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()).optional() })
});

describe("an embedding host's token without a delegated actor", () => {
  it("is the host acting for the person, with the person's chat scopes", async () => {
    const { t, embed, authenticate } = await setup();
    const identity = await authenticate(embed);
    expect(identity).toMatchObject({
      id: t.kai.id,
      principal: { kind: "user", id: t.kai.id },
      delegatedActor: { kind: "service_principal", id: "embedding-host" }
    });
    expect(identity.authenticationMethod).toBeUndefined();
    expect(identity.scopes).toEqual([...CHAT_SESSION_AUTH_SCOPES]);
  });

  it("tells the interface it is embedded, which the person's own session is not", async () => {
    const { t, embed, own } = await setup();
    const read = async (headers: Record<string, string>) =>
      z
        .object({ id: z.string(), embedded: z.literal(true).optional() })
        .parse((await t.expectOk(t.kai.id, "me.get", { headers })).json());

    // The flag, and nothing of the host: the read names no more of it than it did before.
    const embedded = await read(embed);
    expect(embedded).toMatchObject({ id: t.kai.id, embedded: true });
    expect(JSON.stringify(embedded)).not.toContain(HOST_USER);
    expect(await read(own)).not.toHaveProperty("embedded");
  });

  it("never chooses the person's own agent, which their own session still does", async () => {
    const { t, home, chat, embed, own } = await setup();
    const listed = z.object({ ownChatAgents: z.array(z.object({ name: z.string() })).optional() });
    const list = async (headers: Record<string, string>) =>
      listed.parse(
        (
          await t.expectOk(t.kai.id, "workspaces.agents.list", {
            params: { collaborationWorkspaceId: home },
            headers
          })
        ).json()
      ).ownChatAgents;
    const start = (conversationId: string, headers: Record<string, string>, key: string) =>
      t.call(t.kai.id, "conversations.runs.start", {
        params: { conversationId },
        payload: { agentName: OWN, idempotencyKey: key, message: { text: "Meine Steuer" } },
        headers
      });

    expect(await list(embed)).toBeUndefined();
    const embedded = await start(await chat(), embed, "embed-1");
    expect(embedded.statusCode, embedded.body).toBe(404);
    expect(errorSchema.parse(embedded.json()).error.code).toBe("NOT_FOUND");

    expect((await list(own))?.map((item) => item.name)).toEqual([OWN]);
    const started = await start(await chat(), own, "own-1");
    expect(started.statusCode, started.body).toBe(200);
  });

  it("never reads the person's confirmations, which their own session does", async () => {
    const { t, embed, own } = await setup();
    const embedded = await t.call(t.kai.id, "me.operation_settings.list", { headers: embed });
    expect(embedded.statusCode, embedded.body).toBe(403);
    await t.expectOk(t.kai.id, "me.operation_settings.list", { headers: own });
  });

  it("never gets the person's Always allow on an agent's call", async () => {
    const { embed, own, authenticate } = await setup();
    const definition: OperationDefinition = {
      name: "rows.insert",
      effect: "changing",
      changeClass: "reversible",
      action: "rows.write",
      scope: null,
      auth: "principal",
      inputSchema: z.object({}),
      outputSchema: z.unknown(),
      resource: () => undefined,
      http: { method: "POST", path: "/rows" },
      timeoutMs: 1000,
      execute: () => Promise.resolve({})
    };
    // The call of an agent in the API, not in a run's worker: only its actor decides.
    const policy = async (actor: AuthenticatedUser) =>
      resolveGuardedPolicy({
        definition,
        call: {
          input: {},
          actor,
          origin: {
            kind: "agent",
            agentRunId: asAgentRunId("run_1"),
            conversationId: asConversationId("conv_1"),
            agentName: "assistant",
            toolCallId: asToolCallId("call_1"),
            toolName: "rows.insert"
          }
        },
        resource: undefined,
        runtime: {},
        emit: () => Promise.resolve(PLATFORM_EVENT_ALLOW),
        deps: {
          policy: {
            instanceDefaults: { reading: "allow", changing: "confirm" },
            centralSettings: () => [],
            personSetting: async () => "always_allow"
          }
        }
      });

    // Nobody can confirm a call outside a worker, so the call the person never let run is refused.
    const embedded = await policy(await authenticate(embed));
    expect(embedded).toMatchObject({ policy: { value: "deny", source: "surface_cannot_pause" } });
    expect(embedded).not.toHaveProperty("offersAlwaysAllow");
    expect(await policy(await authenticate(own))).toMatchObject({
      policy: { value: "allow", source: "person_setting" }
    });
  });

  it("never adds a Data Store as the person's own click, which their own session gets past", async () => {
    const { t, chat, embed, own } = await setup();
    const conversationId = await chat();
    const add = async (headers: Record<string, string>) =>
      errorSchema.parse(
        (
          await t.call(t.kai.id, "conversations.data_stores.add", {
            params: { conversationId },
            payload: { store: "rows", toolCallId: "call_1" },
            headers
          })
        ).json()
      ).error;

    expect(await add(embed)).toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "data_store_use_not_persons_turn" }
    });
    // The person's own click passes that check and stops at the card: no call waits for it.
    expect((await add(own)).details?.reason).not.toBe("data_store_use_not_persons_turn");
  });

  it("never deletes the person's account, which they delete in their own session", async () => {
    const { t, embed, own } = await setup();
    const embedded = await t.call(t.kai.id, "me.delete", { headers: embed });
    expect(embedded.statusCode, embedded.body).toBe(403);
    expect(errorSchema.parse(embedded.json()).error.code).toBe("FORBIDDEN");
    expect(
      (await t.stores.users.getUser({ clientInstanceId, userId: asUserId(t.kai.id) }))?.status
    ).toBe("active");

    const deleted = await t.call(t.kai.id, "me.delete", { headers: own });
    expect([200, 202], deleted.body).toContain(deleted.statusCode);
  });
});
