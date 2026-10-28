import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  usageBreakdownSchema,
  usageSummarySchema,
  workspaceUsageSchema
} from "@work-shape/catalyst-api-contract";
import {
  asAgentRunId,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  AGENTS_RUN_OPERATION,
  asServicePrincipalId,
  asToolCallId,
  asUserId,
  chatReadOnlyBy,
  createUserPrincipal,
  createPlatformId,
  mayUseOwnInChat,
  PERSONAL_AGENTS_KEY,
  servicePrincipalAsRunUser,
  type AgentRuntime,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type CollaborationWorkspaceId
} from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { registerSubagentOperation } from "@work-shape/catalyst-server";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { waitUntil } from "./support/assertions";
import { createMultipartFilePayload } from "./support/chat-server-attachment-harness";
import { withTestSql } from "./support/test-sql";
import { createTestConfig } from "./support/fixtures";
import { createStoredConfigAssetSource } from "./support/static-config-asset-source";
import { createToolCallingModel, TOOL_CALLING_MODEL_PROVIDER } from "./support/held-model";
import {
  createTestInstance,
  getTestConfig,
  getTestOperationCalls,
  type TestInstance
} from "./support/test-instance";

// A person's own agent ("Nur ich", owned by their Personal Workspace) is offered in no
// workspace. Its owner chooses it in any chat they created that nobody else reads: their
// Personal Workspace's, or a private one in a team. Choosing it marks the chat personal, so it
// can never be read by the team. Never in a chat others read, never for another person, a key,
// a subagent or a service principal.

const OWN = "kai-tax";
const KEY = { "x-test-key": "personal" };
const instances: AccessInstance[] = [];
const running: TestInstance[] = [];
afterEach(async () => {
  await Promise.all([
    ...instances.splice(0).map((t) => t.instance.close()),
    ...running.splice(0).map((app) => app.close())
  ]);
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

const listedSchema = z.object({
  items: z.array(z.object({ name: z.string() })),
  ownChatAgents: z.array(z.object({ name: z.string(), displayName: z.string() })).optional()
});
const idSchema = z.object({ id: z.string(), visibility: z.string() });

/** Kai and Lena are members of TEAM; Kai owns an agent in his Personal Workspace. */
async function setup() {
  const t = await setupAccessInstance({
    storedAssetSource: true,
    server: () => ({ agentRuntime: queuedRuntime })
  });
  instances.push(t);
  const team = await t.sharedWorkspace("TEAM");
  for (const user of [t.kai, t.lena]) {
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(user.id),
      role: "member"
    });
  }
  const kaiHome = (
    await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(t.kai.id)
    })
  ).id;
  // As a draft Kai publishes is stored: owned by his Personal Workspace, offered nowhere.
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    initialAgentAvailability: "hidden",
    mutations: [
      {
        type: "upsert",
        kind: "agent",
        name: OWN,
        config: agent(OWN, { displayName: "Kais Steuer" }),
        scope: { kind: "workspace", workspaceId: kaiHome }
      }
    ]
  });
  const chat = async (
    userId: string,
    workspaceId: CollaborationWorkspaceId,
    visibility?: "private"
  ) =>
    idSchema.parse(
      (
        await t.expectOk(userId, "conversations.create", {
          payload: {
            title: "Own",
            collaborationWorkspaceId: workspaceId,
            ...(visibility ? { visibility } : {})
          }
        })
      ).json()
    );
  let runs = 0;
  const start = (userId: string, conversationId: string, headers = {}) => {
    runs += 1;
    return t.call(userId, "conversations.runs.start", {
      params: { conversationId },
      payload: { agentName: OWN, idempotencyKey: `own-${runs}`, message: { text: "Meine Steuer" } },
      headers
    });
  };
  const listed = async (userId: string, workspaceId: CollaborationWorkspaceId, headers = {}) =>
    listedSchema.parse(
      (
        await t.expectOk(userId, "workspaces.agents.list", {
          params: { collaborationWorkspaceId: workspaceId },
          headers
        })
      ).json()
    );
  const marked = async (conversationId: string) =>
    (
      await t.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(conversationId)
      )
    )?.personalDataAt !== undefined;
  return { t, team, kaiHome, chat, start, listed, marked };
}

const notFound = { status: 404, code: "NOT_FOUND" };

describe("an agent of Only me in its owner's own chats", () => {
  it("is offered nowhere, and listed to its owner alone for their own chats", async () => {
    const { t, team, kaiHome, listed } = await setup();
    const kai = await listed(t.kai.id, team);
    expect(kai.items.map((item) => item.name)).not.toContain(OWN);
    expect(kai.ownChatAgents).toEqual([
      expect.objectContaining({ name: OWN, displayName: "Kais Steuer" })
    ]);
    expect((await listed(t.kai.id, kaiHome)).ownChatAgents?.map((item) => item.name)).toEqual([
      OWN
    ]);
    // Another member never sees it, and a key of its owner lists nothing of the kind.
    expect((await listed(t.lena.id, team)).ownChatAgents).toBeUndefined();
    expect((await listed(t.kai.id, team, KEY)).ownChatAgents).toBeUndefined();
  });

  it("runs in its owner's private team chat and marks it, which then stays private", async () => {
    const { t, team, chat, start, marked } = await setup();
    const own = await chat(t.kai.id, team, "private");
    expect(await marked(own.id)).toBe(false);
    const started = await start(t.kai.id, own.id);
    expect(started.statusCode, started.body).toBe(200);
    expect(await marked(own.id)).toBe(true);

    // Moved to the team for its members to read, the chat is refused; it stays Kai's alone.
    await t.expectRefused(
      t.kai.id,
      "conversations.move",
      {
        params: { conversationId: own.id },
        payload: { collaborationWorkspaceId: team, visibility: "workspace" }
      },
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "personal_conversation_private" }
      }
    );
  });

  it("runs in its owner's Personal Workspace, whose chat then never moves to a team for its members", async () => {
    const { t, team, kaiHome, chat, start, marked } = await setup();
    const home = await chat(t.kai.id, kaiHome);
    const started = await start(t.kai.id, home.id);
    expect(started.statusCode, started.body).toBe(200);
    expect(await marked(home.id)).toBe(true);
    await t.expectRefused(
      t.kai.id,
      "conversations.move",
      {
        params: { conversationId: home.id },
        payload: { collaborationWorkspaceId: team, visibility: "workspace" }
      },
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "personal_conversation_private" }
      }
    );
  });

  it("is refused in a chat the team reads, which stays unmarked", async () => {
    const { t, team, chat, marked } = await setup();
    const shared = await chat(t.kai.id, team);
    expect(shared.visibility).toBe("workspace");
    await t.expectRefused(
      t.kai.id,
      "conversations.runs.start",
      {
        params: { conversationId: shared.id },
        payload: { agentName: OWN, idempotencyKey: "team-1", message: { text: "Meine Steuer" } }
      },
      notFound
    );
    expect(await marked(shared.id)).toBe(false);
  });

  it("is the agent a file is read for only in its owner's own chat", async () => {
    const { t, team, chat } = await setup();
    const upload = (conversationId: string) => {
      const multipart = createMultipartFilePayload({
        fieldName: "file",
        filename: "steuer.txt",
        contentType: "text/plain",
        content: Buffer.from("Meine Steuer")
      });
      return t.call(t.kai.id, "conversations.draft_attachments.upload", {
        params: { conversationId },
        query: { agentName: OWN },
        headers: multipart.headers,
        payload: multipart.payload
      });
    };
    // This instance stores no files: past the agent's check, the upload stops there.
    const own = await upload((await chat(t.kai.id, team, "private")).id);
    expect(own.json()).toMatchObject({
      error: { message: "Attachment handling is not configured" }
    });
    const shared = await upload((await chat(t.kai.id, team)).id);
    expect(shared.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "The selected agent is not available" }
    });
  });

  it("is refused to another member, even in their own private chat", async () => {
    const { t, team, chat, marked } = await setup();
    const lenas = await chat(t.lena.id, team, "private");
    await t.expectRefused(
      t.lena.id,
      "conversations.runs.start",
      {
        params: { conversationId: lenas.id },
        payload: { agentName: OWN, idempotencyKey: "lena-1", message: { text: "Kais Steuer" } }
      },
      notFound
    );
    expect(await marked(lenas.id)).toBe(false);
  });

  it("is refused to its owner's key, in the owner's own private chat", async () => {
    const { t, team, chat, start, marked } = await setup();
    const own = await chat(t.kai.id, team, "private");
    const started = await start(t.kai.id, own.id, KEY);
    expect(started.statusCode, started.body).toBe(404);
    expect(await marked(own.id)).toBe(false);
  });

  it("starts a new chat only where it will be private, leaving nothing behind where it is refused", async () => {
    const { t, team } = await setup();
    const create = (key: string, visibility?: "private") =>
      t.call(t.kai.id, "conversations.runs.create", {
        payload: {
          agentName: OWN,
          idempotencyKey: key,
          message: { text: "Meine Steuer" },
          conversation: { collaborationWorkspaceId: team, ...(visibility ? { visibility } : {}) }
        }
      });
    const kaisChats = () =>
      withTestSql(
        (sql) => sql<{ visibility: string; personal_data_at: Date | null }[]>`
          select visibility, personal_data_at from conversations
          where client_instance_id = ${clientInstanceId} and created_by_user_id = ${t.kai.id}
            and collaboration_workspace_id = ${team}`
      );
    expect((await create("new-team")).statusCode).toBe(404);
    expect(await kaisChats()).toEqual([]);
    const created = await create("new-private", "private");
    expect(created.statusCode, created.body).toBe(200);
    const made = await kaisChats();
    expect(made).toHaveLength(1);
    expect(made[0]?.visibility).toBe("private");
    expect(made[0]?.personal_data_at).not.toBeNull();
  });
});

describe("an agent of Only me beyond the chat its owner chose it in", () => {
  it("is refused for a scheduled prompt, even in its owner's own private chat", async () => {
    const { t, team } = await setup();
    await t.expectRefused(
      t.kai.id,
      "scheduled_starts.create",
      {
        payload: {
          agentName: OWN,
          prompt: "Daily",
          cron: "0 9 * * 1-5",
          timeZone: "Europe/Berlin",
          collaborationWorkspaceId: team
        }
      },
      { status: 404, code: "NOT_FOUND" }
    );
  });

  it("acts on a call that waited only in the owner's own marked chat", async () => {
    const { t, team, kaiHome, chat, start } = await setup();
    const calls = await getTestOperationCalls(t.instance);
    const person = (userId: string, overrides: Partial<AuthenticatedUser> = {}) =>
      ({
        id: userId,
        externalUserId: userId,
        displayLabel: userId,
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "test",
        ...overrides
      }) satisfies AuthenticatedUser;
    const available = (conversationId: string | undefined, actor = person(t.kai.id)) =>
      calls.deps.agentAvailable?.({
        agentName: OWN,
        workspaceId: team,
        actor,
        ...(conversationId ? { conversationId: asConversationId(conversationId) } : {})
      });
    const own = await chat(t.kai.id, team, "private");
    // Not yet chosen there, so the chat is not marked: nothing of Kai's own acts in it.
    expect(await available(own.id)).toBe(false);
    expect((await start(t.kai.id, own.id)).statusCode).toBe(200);
    expect(await available(own.id)).toBe(true);
    // A subagent's start asks without the chat; a key of Kai's and another person never count.
    expect(await available(undefined)).toBe(false);
    expect(await available(own.id, person(t.kai.id, { keyScopes: ["*"] }))).toBe(false);
    expect(await available(own.id, person(t.lena.id))).toBe(false);
    // Lena's own private chat, marked by something of hers, never runs Kai's agent.
    const lenas = await chat(t.lena.id, team, "private");
    await t.stores.conversations.markPersonalData({
      clientInstanceId,
      conversationId: asConversationId(lenas.id),
      userId: t.lena.id,
      at: new Date().toISOString()
    });
    expect(await available(lenas.id, person(t.lena.id))).toBe(false);
    // A chat the team reads never counts, nor one in another workspace than the call's.
    const shared = await chat(t.kai.id, team);
    expect(await available(shared.id)).toBe(false);
    expect(
      await calls.deps.agentAvailable?.({
        agentName: OWN,
        workspaceId: kaiHome,
        actor: person(t.kai.id),
        conversationId: asConversationId(own.id)
      })
    ).toBe(false);
  });

  it("runs itself as a subagent only for its owner, in a chat only the owner reads", async () => {
    const { t, team, chat } = await setup();
    const calls = await getTestOperationCalls(t.instance);
    registerSubagentOperation(calls.registry, {
      clientInstanceId,
      stores: t.stores,
      assetSource: createStoredConfigAssetSource({
        store: t.stores.configAssets,
        clientInstanceId
      }),
      agentAvailable: async (input) => (await calls.deps.agentAvailable?.(input)) ?? false
    });
    const person = (userId: string, overrides: Partial<AuthenticatedUser> = {}) =>
      ({
        id: userId,
        externalUserId: userId,
        displayLabel: userId,
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "test",
        ...overrides
      }) satisfies AuthenticatedIdentity;
    // A running run of OWN in a chat, as its owner choosing it there left it: the chat marked.
    const parentIn = async (conversationId: string, mark = true) => {
      const id = asConversationId(conversationId);
      // The store never marks a chat others read.
      if (mark)
        await t.stores.conversations.markPersonalData({
          clientInstanceId,
          conversationId: id,
          userId: t.kai.id,
          at: new Date().toISOString()
        });
      const message = await t.stores.conversations.appendMessage({
        clientInstanceId,
        conversationId: id,
        role: "user",
        text: "Meine Steuer"
      });
      return t.stores.agentRuns.createAgentRun({
        id: asAgentRunId(`run_${randomUUID()}`),
        clientInstanceId,
        conversationId: id,
        ownerUserId: t.kai.id,
        inputMessageId: message.id,
        agentName: OWN,
        status: "running",
        startedAt: new Date().toISOString(),
        correlationId: randomUUID(),
        authorization: {
          personalConnectionsAllowed: true,
          principal: createUserPrincipal(person(t.kai.id)),
          subjectUserId: t.kai.id,
          scopes: ["*"]
        }
      });
    };
    const runItself = (
      parent: Awaited<ReturnType<typeof parentIn>>,
      actor: AuthenticatedIdentity,
      input: { agent?: string } = {}
    ) =>
      runOperation(
        {
          operation: AGENTS_RUN_OPERATION,
          effect: "changing",
          input: { description: "Tax", task: "Check.", ...input },
          actor,
          origin: {
            kind: "agent",
            agentRunId: parent.id,
            conversationId: parent.conversationId,
            agentName: parent.agentName,
            toolCallId: asToolCallId(`call_${randomUUID()}`),
            toolName: AGENTS_RUN_OPERATION
          },
          correlationId: randomUUID()
        },
        {
          ...calls.deps,
          agentToolNames: () => [AGENTS_RUN_OPERATION],
          // A changing call in a personal chat waits for its person's confirmation; what the
          // person confirms is not under test here, only whether the agent may be started.
          policy: { ...calls.deps.policy, personalConversation: async () => false }
        },
        { modelRoutes: [{ id: "local", region: "eu" }] }
      );

    const own = await chat(t.kai.id, team, "private");
    const parent = await parentIn(own.id);
    // The owner's own agent, left out of 'agent', runs itself in a chat only the owner reads.
    const ran = await runItself(parent, person(t.kai.id));
    expect(ran.result, JSON.stringify(ran.result)).toMatchObject({
      status: "done",
      output: { agent: OWN }
    });
    // Another member, a key and a Workflow step's principal never run it.
    for (const [what, actor] of [
      ["another member", person(t.lena.id)],
      ["the owner's key", person(t.kai.id, { keyScopes: ["*"] })],
      [
        "a Workflow step",
        servicePrincipalAsRunUser({
          kind: "service",
          id: asServicePrincipalId(t.kai.id),
          workflowRunId: createPlatformId<"WorkflowRunId">("wfrun"),
          displayLabel: "Books",
          permissionRefs: [],
          permissions: [],
          clientInstanceId,
          authSource: "test",
          scopes: []
        })
      ]
    ] as const) {
      expect((await runItself(parent, actor)).result.status, what).not.toBe("done");
    }
    // A chat the team reads never runs it, whoever asks.
    const shared = await chat(t.kai.id, team);
    expect(shared.visibility).toBe("workspace");
    const inShared = await parentIn(shared.id, false);
    expect((await runItself(inShared, person(t.kai.id))).result.status).not.toBe("done");
  });

  it("is never started as a subagent, even by an agent of its owner's own chat", async () => {
    const toolModel = createToolCallingModel();
    const config = createTestConfig({
      toolNames: ["run_agent"],
      sessionToken: { issuer: "own-agents-runtime", ttlSeconds: 900 },
      developmentAuth: {
        enabled: true,
        users: [
          {
            id: "kai",
            externalUserId: "kai",
            displayLabel: "Kai",
            roles: ["user"],
            permissionRefs: []
          }
        ],
        defaultUserId: "kai"
      }
    });
    config.infrastructure.models = {
      local: { provider: TOOL_CALLING_MODEL_PROVIDER, model: "local" }
    };
    const app = await createTestInstance({
      config,
      env: {
        CHAT_SESSION_TOKEN_SECRET: "own-agents-test-session-signing-key-for-tests",
        CHAT_SERVER_CREDENTIAL: "own-agents-test-server-credential"
      },
      capabilities: [toolModel.capability],
      tools: []
    });
    running.push(app);
    const instanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
    const created = await app.call("conversations.create", { payload: { title: "Mine" } });
    expect(created.statusCode, created.body).toBe(200);
    const home = created.json<{ id: string; collaborationWorkspaceId: string }>();
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
          name: "test_agent",
          config: {
            name: "test_agent",
            displayName: "Test Agent",
            toolNames: ["run_agent"],
            subagentNames: [OWN],
            ...plain
          }
        }
      ]
    });
    await applyAtCurrentRevisions(app.stores.configAssets, {
      clientInstanceId: instanceId,
      initialAgentAvailability: "hidden",
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: OWN,
          config: { name: OWN, displayName: "Kais Steuer", toolNames: [], ...plain },
          scope: {
            kind: "workspace",
            workspaceId: asCollaborationWorkspaceId(home.collaborationWorkspaceId)
          }
        }
      ]
    });
    const run = async (conversationId: string, agentName: string, text: string) => {
      const started = await app.call("conversations.runs.start", {
        params: { conversationId },
        payload: { agentName, idempotencyKey: `${agentName}-${text.length}`, message: { text } }
      });
      expect(started.statusCode, started.body).toBe(200);
      const runId = asAgentRunId(started.json<{ run: { id: string } }>().run.id);
      await waitUntil(async () => {
        const stored = await app.stores.agentRuns.getAgentRun({
          clientInstanceId: instanceId,
          runId
        });
        return stored?.status === "completed";
      }, "the run completes");
      return (
        await app.stores.agentRuns.listRunObservations({ clientInstanceId: instanceId, runId })
      ).map((observation) => observation.payload);
    };

    // Kai's own agent runs in his own chat, which it marks.
    await run(home.id, OWN, "Meine Steuer.");
    const marked = await app.stores.conversations.getConversation(
      instanceId,
      asConversationId(home.id)
    );
    expect(marked?.personalDataAt).toBeDefined();

    // An agent offered to all cannot start it as its subagent, in another chat of Kai's own.
    const other = await app.call("conversations.create", { payload: { title: "Other" } });
    const events = await run(
      other.json<{ id: string }>().id,
      "test_agent",
      `/tool run_agent ${JSON.stringify({ agent: OWN, description: "Tax", task: "Check." })}`
    );
    expect(events.filter((event) => event.type === "subagent_started")).toEqual([]);
    expect(
      events.some(
        (event) =>
          event.type === "tool_call_failed" && JSON.stringify(event).includes("agent_not_available")
      )
    ).toBe(true);
  });
});

describe("an agent of Only me in the usage of a team", () => {
  it("counts to the team without its name, for the team's Owner and the Usage page alike", async () => {
    const usageOf = (store: AccessInstance["stores"]["usage"]) =>
      new ModelUsageGovernance({ store, costs: {}, budget: {}, safeguards: {} });
    const t = await setupAccessInstance({
      storedAssetSource: true,
      server: (stores) => ({ usageGovernance: usageOf(stores.usage) })
    });
    instances.push(t);
    const team = await t.sharedWorkspace("TEAM");
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.lena.id),
      role: "owner"
    });
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.kai.id),
      role: "member"
    });
    const kaiHome = (
      await t.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(t.kai.id)
      })
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
          scope: { kind: "workspace", workspaceId: kaiHome }
        }
      ]
    });
    const usage = usageOf(t.stores.usage);
    const call = (agentName: string, workspaceId: string, tokens: number) =>
      usage.recordModelUsage({
        clientInstanceId,
        attribution: {
          kind: "agent_run",
          conversationId: asConversationId(`conv_${crypto.randomUUID()}`),
          runId: asAgentRunId(`run_${crypto.randomUUID()}`),
          agentName,
          userId: t.kai.id,
          workspaceId
        },
        providerId: "local",
        model: "local",
        correlationId: `corr_${crypto.randomUUID()}`,
        inputTokens: tokens,
        cachedInputTokens: 0,
        outputTokens: tokens,
        totalTokens: tokens * 2,
        source: "provider_reported"
      });
    await call(OWN, team, 1_000);
    await call("test_agent", team, 300);
    // In his Personal Workspace it counts to every Personal Workspace's one row, as before.
    await call(OWN, kaiHome, 50);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const period = { from: today, to: tomorrow };

    const owner = workspaceUsageSchema.parse(
      (
        await t.expectOk(t.lena.id, "workspaces.usage.get", {
          params: { collaborationWorkspaceId: team },
          query: { ...period, groupBy: "agent" }
        })
      ).json()
    );
    expect(JSON.stringify(owner)).not.toContain(OWN);
    expect(owner.breakdown.rows.map((row) => [row.key, row.totalTokens])).toEqual([
      [PERSONAL_AGENTS_KEY, 2_000],
      ["test_agent", 600]
    ]);

    const instanceView = usageBreakdownSchema.parse(
      (
        await t.expectOk(t.admin.id, "usage.breakdown.get", {
          query: { ...period, groupBy: "agent", workspace: team }
        })
      ).json()
    );
    expect(instanceView.rows.map((row) => row.key)).toEqual([PERSONAL_AGENTS_KEY, "test_agent"]);
    const summary = usageSummarySchema.parse(
      (await t.expectOk(t.admin.id, "usage.get_summary")).json()
    );
    const inTeam = summary.recentEvents.filter((event) => event.workspace?.key === team);
    expect(inTeam.map((event) => event.agentName).sort()).toEqual([
      PERSONAL_AGENTS_KEY,
      "test_agent"
    ]);
  });
});

describe("the chat audience rule shared with personal chat skills", () => {
  const kai = {
    id: "kai",
    externalUserId: "kai",
    displayLabel: "Kai",
    roles: [],
    permissionRefs: [],
    clientInstanceId,
    authSource: "test"
  } satisfies AuthenticatedUser;
  const team = { kind: "shared" as const, personalUserId: null };
  const home = { kind: "personal" as const, personalUserId: "kai" };
  const chat = { kind: "chat" as const, status: "active" as const, createdByUserId: "kai" };

  it("admits only a chat its person created that nobody else reads", () => {
    expect(chatReadOnlyBy({ ...chat, visibility: "private" }, team, "kai")).toBe(true);
    expect(chatReadOnlyBy({ ...chat, visibility: "workspace" }, home, "kai")).toBe(true);
    expect(chatReadOnlyBy({ ...chat, visibility: "workspace" }, team, "kai")).toBe(false);
    expect(chatReadOnlyBy({ ...chat, visibility: "private" }, team, "lena")).toBe(false);
    expect(
      chatReadOnlyBy(
        { ...chat, visibility: "workspace" },
        { ...home, personalUserId: "lena" },
        "kai"
      )
    ).toBe(false);
    expect(
      chatReadOnlyBy({ ...chat, kind: "run_thread", visibility: "private" }, team, "kai")
    ).toBe(false);
  });

  it("refuses a key, an embedding host and a chat that is gone", () => {
    const own = { ...chat, visibility: "private" as const };
    expect(mayUseOwnInChat(kai, own, team)).toBe(true);
    expect(mayUseOwnInChat({ ...kai, keyScopes: ["*"] }, own, team)).toBe(false);
    expect(
      mayUseOwnInChat(
        { ...kai, delegatedActor: { kind: "service_principal", id: "host", authSource: "test" } },
        own,
        team
      )
    ).toBe(false);
    expect(mayUseOwnInChat(kai, { ...own, status: "deleted" }, team)).toBe(false);
  });
});
