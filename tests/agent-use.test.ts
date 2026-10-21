import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { roleSchema, scheduledStartSchema } from "@work-shape/catalyst-api-contract";
import {
  asAgentRunId,
  asClientInstanceId,
  asUserId,
  type AgentRuntime,
  type CollaborationWorkspaceId,
  type PlatformStores
} from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { required, waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createToolCallingModel, TOOL_CALLING_MODEL_PROVIDER } from "./support/held-model";
import {
  createTestInstance,
  getTestConfig,
  getTestJobs,
  type TestInstance
} from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// AGENT-USE-1: who may use an agent where it is available. An agent set to Everyone is used by
// everyone who may work where it is available, as before; one limited to `agent.use` only by
// whom a row allows. Availability and the right must both allow, at every entry.

const AGENT = "workshaper-like";
const instances: AccessInstance[] = [];
const running: TestInstance[] = [];
afterEach(async () => {
  await Promise.all([
    ...instances.splice(0).map((t) => t.instance.close()),
    ...running.splice(0).map((app) => app.close())
  ]);
});

const agentsListed = z.object({ items: z.array(z.object({ name: z.string() })) });

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

/** Kai and Lena are members of KAI, where the agent is offered; the administrator owns KAI. */
async function setup() {
  const t = await setupAccessInstance({
    storedAssetSource: true,
    server: () => ({ agentRuntime: queuedRuntime })
  });
  instances.push(t);
  const kai = await t.sharedWorkspace("KAI");
  for (const user of [t.kai, t.lena, t.root]) {
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: kai,
      userId: asUserId(user.id),
      role: "member"
    });
  }
  await t.expectOk(t.admin.id, "assets.put", {
    params: { kind: "agent", name: AGENT },
    payload: { config: agent(AGENT), availableIn: { workspaceId: kai } }
  });
  const agentId = await t.assetId("agent", AGENT);
  let runs = 0;
  const conversation = async (userId: string, workspaceId: CollaborationWorkspaceId) =>
    z.object({ id: z.string() }).parse(
      (
        await t.expectOk(userId, "conversations.create", {
          payload: { title: "Use", collaborationWorkspaceId: workspaceId }
        })
      ).json()
    ).id;
  const start = async (userId: string, conversationId: string, agentName = AGENT) => {
    runs += 1;
    return t.call(userId, "conversations.runs.start", {
      params: { conversationId },
      payload: { agentName, idempotencyKey: `use-${runs}`, message: { text: "Secret question" } }
    });
  };
  const listed = async (userId: string) =>
    agentsListed
      .parse(
        (
          await t.expectOk(userId, "workspaces.agents.list", {
            params: { collaborationWorkspaceId: kai }
          })
        ).json()
      )
      .items.map((agent) => agent.name);
  const limit = (use: "everyone" | "granted") =>
    t.expectOk(t.admin.id, "agents.use.set", { params: { name: AGENT }, payload: { use } });
  return { t, kai, agentId, conversation, start, listed, limit };
}

const refusedUse = (reason: "no_grant" | "denied") => ({
  status: 403,
  code: "FORBIDDEN",
  details: { action: "agent.use", reason }
});

async function useRefusals(t: { stores: Pick<PlatformStores, "audit"> }) {
  return t.stores.audit.listAuditEvents({ clientInstanceId, type: "agent.use_refused" });
}

const scheduledRuns = z.object({
  items: z.array(
    z.object({
      status: z.string(),
      reason: z.string().nullable(),
      agentRunId: z.string().nullable(),
      conversationId: z.string().nullable()
    })
  )
});

const toolModel = createToolCallingModel();
const HELPER = "helper";

/**
 * An instance whose runs execute, with a model that makes the calls a message lists. The
 * default agent `test_agent` may start `helper` as a subagent; the administrator holds
 * `agent.use` by default, Kai is a member with no right of his own.
 */
async function runningInstance() {
  const config = createTestConfig({
    toolNames: ["run_agent"],
    sessionToken: { issuer: "agent-use-runtime", ttlSeconds: 900 },
    developmentAuth: {
      enabled: true,
      users: [
        {
          id: "admin",
          externalUserId: "admin",
          displayLabel: "Admin",
          roles: ["user", "admin"],
          permissionRefs: []
        },
        {
          id: "kai",
          externalUserId: "kai",
          displayLabel: "Kai",
          roles: ["user"],
          permissionRefs: []
        }
      ],
      defaultUserId: "admin"
    }
  });
  config.infrastructure.models = {
    local: { provider: TOOL_CALLING_MODEL_PROVIDER, model: "local" }
  };
  const app = await createTestInstance({
    config,
    env: {
      CHAT_SESSION_TOKEN_SECRET: "agent-use-test-session-signing-key-for-tests",
      CHAT_SERVER_CREDENTIAL: "agent-use-test-server-credential"
    },
    capabilities: [toolModel.capability],
    tools: []
  });
  running.push(app);
  const instanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const plain = {
    instructions: "Use configured tools only.",
    modelProviderId: "local",
    initialPrompts: []
  };
  await applyAtCurrentRevisions(app.stores.configAssets, {
    clientInstanceId: instanceId,
    mutations: [
      {
        type: "upsert",
        kind: "agent",
        name: HELPER,
        config: { name: HELPER, displayName: "Helper", toolNames: [], ...plain }
      },
      {
        type: "upsert",
        kind: "agent",
        name: "test_agent",
        config: {
          name: "test_agent",
          displayName: "Test Agent",
          toolNames: ["run_agent"],
          subagentNames: [HELPER],
          ...plain
        }
      }
    ]
  });
  const as = (userId: string) => ({ "x-dev-user-id": userId });
  /** A message to `test_agent` in a new conversation of the person, run to its end. */
  const say = async (userId: string, text: string) => {
    const created = await app.call("conversations.create", {
      payload: { title: "Split" },
      headers: as(userId)
    });
    expect(created.statusCode, created.body).toBe(200);
    const started = await injectStartConversationRun(app, created.json<{ id: string }>().id, text, {
      headers: as(userId)
    });
    const runId = started.run.id;
    await waitUntil(async () => {
      const run = await app.stores.agentRuns.getAgentRun({
        clientInstanceId: instanceId,
        runId: asAgentRunId(runId)
      });
      return run?.status === "completed";
    }, "the parent run completes");
    return (
      await app.stores.agentRuns.listRunObservations({
        clientInstanceId: instanceId,
        runId: asAgentRunId(runId)
      })
    ).map((observation) => observation.payload);
  };
  return { app, say };
}

describe("agent.use", () => {
  it("keeps every agent usable by everyone where it is available until it is limited", async () => {
    const { t, kai, conversation, start, listed } = await setup();
    const read = z
      .object({ agentUse: z.string() })
      .parse(
        (
          await t.expectOk(t.admin.id, "assets.get", { params: { kind: "agent", name: AGENT } })
        ).json()
      );
    expect(read.agentUse).toBe("everyone");
    expect(await listed(t.kai.id)).toContain(AGENT);
    expect((await start(t.kai.id, await conversation(t.kai.id, kai))).statusCode).toBe(200);
  });

  it("refuses a person without the right on a limited agent, by name over the API as in the picker", async () => {
    const { t, kai, agentId, conversation, start, listed, limit } = await setup();
    await limit("granted");
    expect(await listed(t.kai.id)).not.toContain(AGENT);

    const chat = await conversation(t.kai.id, kai);
    await t.expectRefused(
      t.kai.id,
      "conversations.runs.start",
      {
        params: { conversationId: chat },
        payload: { agentName: AGENT, idempotencyKey: "denied-1", message: { text: "Secret" } }
      },
      refusedUse("no_grant")
    );
    const messages = await t.expectOk(t.kai.id, "conversations.messages.list", {
      params: { conversationId: chat }
    });
    expect(z.object({ items: z.array(z.unknown()) }).parse(messages.json()).items).toEqual([]);

    // The create-and-run entry refuses before a conversation exists.
    await t.expectRefused(
      t.kai.id,
      "conversations.runs.create",
      {
        payload: {
          agentName: AGENT,
          idempotencyKey: "denied-2",
          message: { text: "Secret" },
          conversation: { collaborationWorkspaceId: kai }
        }
      },
      refusedUse("no_grant")
    );

    // A scheduled prompt is refused when it is made.
    await t.expectRefused(
      t.kai.id,
      "scheduled_starts.create",
      {
        payload: {
          agentName: AGENT,
          prompt: "Daily",
          cron: "0 9 * * 1-5",
          timeZone: "Europe/Berlin",
          collaborationWorkspaceId: kai
        }
      },
      refusedUse("no_grant")
    );

    const refusals = await useRefusals(t);
    expect(refusals.map((event) => event.metadata?.entry).sort()).toEqual([
      "conversation",
      "conversation",
      "schedule"
    ]);
    for (const event of refusals) {
      expect(event).toMatchObject({
        status: "denied",
        reason: "no_grant",
        subject: agentId,
        metadata: { agentName: AGENT, agentId, workspaceId: kai }
      });
      // A minimized governance event: nothing of what was asked.
      expect(JSON.stringify(event)).not.toContain("Secret");
    }
    // Others are unaffected: the administrator holds `agent.use` by default.
    expect((await start(t.admin.id, await conversation(t.admin.id, kai))).statusCode).toBe(200);
  });

  it("lets a person or a role given the right use a limited agent, and a superadmin always", async () => {
    const { t, kai, agentId, conversation, start, listed, limit } = await setup();
    await limit("granted");

    await t.grant(t.kai.id, "agent.use", { assetId: agentId });
    expect(await listed(t.kai.id)).toContain(AGENT);
    expect((await start(t.kai.id, await conversation(t.kai.id, kai))).statusCode).toBe(200);

    const builders = roleSchema.parse(
      (
        await t.expectOk(t.admin.id, "roles.create", {
          payload: {
            name: "Builders",
            grants: [{ action: "agent.use", scopeKind: "asset", scopeId: agentId }]
          }
        })
      ).json()
    );
    expect(await listed(t.lena.id)).not.toContain(AGENT);
    await t.expectOk(t.admin.id, "users.update", {
      params: { userId: t.lena.id },
      payload: { roles: ["user", builders.id] }
    });
    expect(await listed(t.lena.id)).toContain(AGENT);
    expect((await start(t.lena.id, await conversation(t.lena.id, kai))).statusCode).toBe(200);

    expect(await listed(t.root.id)).toContain(AGENT);
    expect((await start(t.root.id, await conversation(t.root.id, kai))).statusCode).toBe(200);
  });

  it("never makes an agent usable where it is not available, also with the right", async () => {
    const { t, agentId, conversation, start, limit } = await setup();
    await limit("granted");
    await t.grant(t.kai.id, "agent.use", { assetId: agentId });
    const elsewhere = await t.sharedWorkspace("Elsewhere");
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: elsewhere,
      userId: asUserId(t.kai.id),
      role: "member"
    });
    const refused = await start(t.kai.id, await conversation(t.kai.id, elsewhere));
    expect(refused.statusCode).toBe(404);
  });

  it("lets a deny keep one person from an agent everyone else uses", async () => {
    const { t, kai, agentId, conversation, start, listed } = await setup();
    await t.grant(t.kai.id, "agent.use", { assetId: agentId }, "deny");
    expect(await listed(t.kai.id)).not.toContain(AGENT);
    expect(await listed(t.lena.id)).toContain(AGENT);
    const refused = await start(t.kai.id, await conversation(t.kai.id, kai));
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: { code: "FORBIDDEN", details: { action: "agent.use", reason: "denied" } }
    });
    expect((await start(t.lena.id, await conversation(t.lena.id, kai))).statusCode).toBe(200);
  });

  it("is set by whoever sets the agent's availability, and recorded", async () => {
    const { t, agentId, limit } = await setup();
    await t.expectRefused(
      t.kai.id,
      "agents.use.set",
      { params: { name: AGENT }, payload: { use: "granted" } },
      t.forbidden("agent.write", "no_grant")
    );
    await limit("granted");
    const read = z
      .object({ agentUse: z.string() })
      .parse(
        (
          await t.expectOk(t.admin.id, "assets.get", { params: { kind: "agent", name: AGENT } })
        ).json()
      );
    expect(read.agentUse).toBe("granted");
    const [set] = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "config_asset.use_set"
    });
    expect(set).toMatchObject({
      metadata: { name: AGENT, agentId, before: "everyone", use: "granted" }
    });
  });

  it("skips a scheduled prompt made while the agent was open once it is limited, and records it", async () => {
    const { t, kai, agentId, limit } = await setup();
    const made = await t.expectOk(t.kai.id, "scheduled_starts.create", {
      payload: {
        agentName: AGENT,
        prompt: "Secret daily question",
        cron: "0 9 * * 1-5",
        timeZone: "Europe/Berlin",
        collaborationWorkspaceId: kai
      }
    });
    const start = scheduledStartSchema.parse(made.json());
    await limit("granted");

    // Only this prompt's next tick is moved to the database's present. No wall-clock sleep.
    await withTestSql(async (sql) => {
      await sql`update platform_jobs set run_after = now() where client_instance_id = ${clientInstanceId} and kind = 'scheduled_prompt.fire' and subject = ${start.id} and status = 'queued'`;
    });
    await getTestJobs(t.instance).runDue();

    const runs = scheduledRuns.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.runs", {
          params: { scheduledStartId: start.id }
        })
      ).json()
    ).items;
    // The tick starts nothing; its history shows the reason, as for an agent withdrawn from
    // the workspace before its tick.
    expect(runs).toEqual([
      { status: "failed", reason: "agent_unavailable", agentRunId: null, conversationId: null }
    ]);
    const refusals = await useRefusals(t);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      status: "denied",
      reason: "no_grant",
      subject: agentId,
      metadata: { entry: "schedule", agentName: AGENT, agentId, workspaceId: kai }
    });
    expect(JSON.stringify(refusals)).not.toContain("Secret");
  });

  it("refuses a subagent start of a limited agent for a person without the right", async () => {
    const { app, say } = await runningInstance();
    // This instance runs without the asset management module; the store sets what
    // `agents.use.set` sets, which the tests above cover.
    await app.stores.configAssets.setAgentUse({
      clientInstanceId,
      agentName: HELPER,
      use: "granted"
    });
    const ask = `/tool run_agent ${JSON.stringify({
      agent: HELPER,
      description: "Help",
      task: "Secret sub-task."
    })}`;

    const kaiEvents = await say("kai", ask);
    expect(kaiEvents.filter((event) => event.type === "subagent_started")).toEqual([]);
    const failed = kaiEvents.flatMap((event) =>
      event.type === "tool_call_failed" ? [JSON.stringify(event)] : []
    );
    expect(failed.some((failure) => failure.includes("agent_not_available"))).toBe(true);
    const refusals = await useRefusals(app);
    expect(refusals).toHaveLength(1);
    expect(required(refusals[0])).toMatchObject({
      status: "denied",
      reason: "no_grant",
      metadata: { entry: "subagent", agentName: HELPER }
    });
    expect(JSON.stringify(refusals)).not.toContain("Secret");

    // The same call by the administrator, who holds `agent.use`, starts the subagent.
    const adminEvents = await say("admin", ask);
    expect(adminEvents.filter((event) => event.type === "subagent_started")).toHaveLength(1);
  });
});
