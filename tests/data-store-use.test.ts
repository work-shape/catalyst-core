import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import type { ModelCompletionRequest } from "@work-shape/catalyst-model-provider";
import { createDataStoreUseTool, ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { createConversationWithMessages, noReportedUsage } from "./helpers/agent-runtime";
import { withTestModelGateway } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";
import {
  createPlatformTools,
  platformModules,
  PLATFORM_TOOL_NAMES
} from "@work-shape/catalyst-client-assembly";
import {
  DATA_STORE_USE_TOOL_NAME,
  asCollaborationWorkspaceId,
  asUserId,
  createModuleRegistry,
  createPlatformId,
  createToolResultMetadata,
  type AssetScope,
  type AuthenticatedUser,
  type Conversation,
  type ConversationVisibility,
  type DataToolSource,
  type AgentRunId,
  type AgentRunWriteFence,
  type ModelProviderConfig,
  type RuntimeCallContext,
  asClientInstanceId
} from "@work-shape/catalyst-core";
import {
  DataStoreUseCardView,
  isDataStoreUseCall,
  readDataStoreUse
} from "@work-shape/catalyst-chat-ui/data-store-use";
import { required } from "./support/assertions";
import { withTestSql } from "./support/test-sql";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import type { DataStoreInstance } from "./support/data-store-instance";
import { seed, store } from "./support/reference-owners";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { EmbeddedSessionProvider } from "./support/chat-ui";

// STORE-USE-1: the agent's `data_store.use` adds a Data Store to the conversation for reading,
// beside its subject. The person's own store is added at once; any other waits for their click
// on a card. Adding grants nothing, only the person's own turn may add, and a Personal
// Workspace's store stays in its owner's own conversations.

const people = ["admin", "owner", "member"] as const;
const auth = {
  enabled: true,
  users: people.map((id) => ({
    id,
    externalUserId: id,
    displayLabel: id,
    roles: id === "admin" ? ["user", "admin", "superadmin"] : ["user"],
    permissionRefs: [],
    permissions: []
  }))
};

const READ_VERBS = ["query", "describe", "preview_rows"];
const readTools = (name: string) => READ_VERBS.map((verb) => `data_store.${name}.${verb}`);
/** What a successful call answered; fails the test for any other answer. */
function outputOf(result: { status: string; output?: unknown }): Record<string, unknown> {
  if (result.status !== "success") throw new Error(JSON.stringify(result));
  return toolOutputOf(result.output);
}

function toolOutputOf(output: unknown): Record<string, unknown> {
  if (typeof output !== "object" || output === null) throw new Error("no output");
  return Object.fromEntries(Object.entries(output));
}

/** A refusal as the agent reads it: the tool's own sentence. */
const refused = (message: string) => ({
  status: "failed",
  error: { message: expect.stringContaining(message) }
});

/** Describes every data tool it is asked for: the offer's own logic decides which. */
const anyDataTools: DataToolSource = {
  describe: async (names) =>
    names.map((name) => ({
      name,
      effect: name.endsWith(".insert") ? ("changing" as const) : ("reading" as const),
      description: name,
      inputJsonSchema: {}
    }))
};

describe("data_store.use", () => {
  const { start } = useDataStoreInstance();

  async function setup() {
    const world = await start(true, "allow", auth, undefined, { apiAccess: true }, undefined, {});
    // The people as the API signs them in, so a click on the card is theirs.
    const signedIn = async (id: (typeof people)[number]) => {
      const me = await world.api.call("me.get", {}, id);
      expect(me.statusCode, me.body).toBe(200);
      const user = required(
        await world.stores.users.getUser({
          clientInstanceId,
          userId: asUserId(me.json<{ id: string }>().id)
        })
      );
      const signed: AuthenticatedUser = {
        id: user.id,
        externalUserId: id,
        displayLabel: id,
        roles: user.roles,
        permissionRefs: [],
        clientInstanceId,
        authSource: "development"
      };
      return signed;
    };
    const admin = await signedIn("admin");
    const owner = await signedIn("owner");
    const member = await signedIn("member");
    const personalOf = (user: AuthenticatedUser) =>
      world.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(user.id)
      });
    const ownersSpace = await personalOf(owner);
    const adminsSpace = await personalOf(admin);
    const team = await world.stores.workspaces.createWorkspace({
      clientInstanceId,
      name: "Team",
      kind: "shared",
      creatorUserId: asUserId(admin.id)
    });
    for (const user of [owner, member]) {
      await world.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team.id,
        userId: asUserId(user.id),
        role: "member"
      });
    }
    const mine: AssetScope = { kind: "workspace", workspaceId: ownersSpace.id };
    const ownStore = await seed(world, "data_store", store("own-store"), mine, true);
    // The owner reads their own store; nobody else is given a right to it.
    await world.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: owner.id,
      action: "data_store.read",
      effect: "allow",
      scopeKind: "asset",
      scopeId: ownStore.id,
      grantedBy: asUserId(admin.id)
    });
    const teamStore = await seed(world, "data_store", store("team-figures"), undefined, true);
    await seed(world, "data_store", store("draft-store"), undefined, false);
    const conversationOf = (
      user: AuthenticatedUser,
      workspaceId: string,
      visibility: ConversationVisibility = "workspace"
    ) =>
      world.stores.conversations.createConversation({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
        createdByUserId: user.id,
        createdByExternalUserId: user.externalUserId,
        visibility,
        title: "Figures",
        retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
      });
    return {
      world,
      admin,
      owner,
      member,
      ownersSpace,
      adminsSpace,
      team,
      ownStore,
      teamStore,
      conversationOf
    };
  }

  /** The agent's call of the tool, as the call path runs it for a run in the conversation. */
  async function use(
    world: DataStoreInstance,
    conversation: Conversation,
    user: AuthenticatedUser,
    name: string,
    runtime: Partial<RuntimeCallContext> = {},
    agentRunId: AgentRunId = createPlatformId<"AgentRunId">("agr")
  ) {
    const runTool = required(world.execution.localAgentRuntimeOptions.runTool);
    const toolCallId = createPlatformId<"ToolCallId">("tc");
    const result = await runTool(
      {
        toolName: DATA_STORE_USE_TOOL_NAME,
        toolCallId,
        agentRunId,
        conversationId: conversation.id,
        agentName: "platform-agent",
        input: { name }
      },
      { clientInstanceId, correlationId: "store-use", user, ...runtime }
    );
    return { result, toolCallId };
  }

  const listed = async (world: DataStoreInstance, conversation: Conversation) =>
    (
      await world.stores.conversations.listConversationDataStores({
        clientInstanceId,
        conversationId: conversation.id
      })
    ).map((row) => row.name);

  const audited = async (world: DataStoreInstance) =>
    (await world.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 })).filter(
      (event) => event.type === "conversation.data_store_added"
    );

  const offerOf = (world: DataStoreInstance, conversation: Conversation, tools: string[]) => {
    const platform = createPlatformTools({
      stores: world.stores,
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => anyDataTools
    });
    platform.registry(platform.tools, new Set());
    return platform.conversationOffer.offerOf({
      clientInstanceId,
      conversationId: conversation.id,
      agentToolNames: tools
    });
  };

  /** The agent's call stored as the run records it, behind a run of the person. */
  async function storedCall(
    world: DataStoreInstance,
    conversation: Conversation,
    owner: AuthenticatedUser,
    toolCallId: string,
    output: unknown,
    toolName: string = DATA_STORE_USE_TOOL_NAME
  ) {
    const message = await world.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "What do the team figures say?"
    });
    const run = await world.stores.agentRuns.createAgentRun({
      id: createPlatformId("run"),
      clientInstanceId,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      inputMessageId: message.id,
      agentName: "test_agent",
      correlationId: "store-use"
    });
    await world.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "tool",
      text: "",
      metadata: createToolResultMetadata({
        runId: run.id,
        toolCall: { toolCallId, toolName, input: {} },
        result: { status: "success", output: toolOutputOf(output) },
        modelOutput: { text: "" }
      })
    });
    return run;
  }

  const click = (
    world: DataStoreInstance,
    conversation: Conversation,
    store: string,
    toolCallId: string,
    as: string | { headers: Record<string, string> }
  ) =>
    world.api.call(
      "conversations.data_stores.add",
      { params: { conversationId: conversation.id }, payload: { store, toolCallId } },
      as
    );

  it("adds the person's own store at once, audited with ids only, and offers its read tools to every agent", async () => {
    const { world, owner, ownersSpace, ownStore, conversationOf } = await setup();
    const chat = await conversationOf(owner, ownersSpace.id);
    expect((await offerOf(world, chat, [...PLATFORM_TOOL_NAMES]))?.toolNames).not.toContain(
      "data_store.own-store.query"
    );
    const { result } = await use(world, chat, owner, "own-store");
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "success",
      output: { name: "own-store", added: true, readTools: readTools("own-store") }
    });
    const output = outputOf(result);
    expect(output).not.toHaveProperty("awaitsPerson");
    expect(await listed(world, chat)).toEqual(["own-store"]);
    const events = await audited(world);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subject: chat.id, status: "success" });
    expect(Object.keys(events[0]?.metadata ?? {}).sort()).toEqual(
      ["by", "operationRunId", "storeAssetId"].sort()
    );
    expect(events[0]?.metadata).toMatchObject({ storeAssetId: ownStore.id, by: "own_store" });
    // A second call adds nothing new and audits nothing more.
    expect((await use(world, chat, owner, "own-store")).result).toMatchObject({
      output: { added: true }
    });
    expect(await audited(world)).toHaveLength(1);

    // The read verbs, never a changing one, beside the platform's own tools; an agent without
    // the platform's tools reads the store too, and is not offered the tool that adds one.
    const holder = required(await offerOf(world, chat, [...PLATFORM_TOOL_NAMES]));
    expect(holder.toolNames).toEqual(expect.arrayContaining(readTools("own-store")));
    expect(holder.toolNames).toContain(DATA_STORE_USE_TOOL_NAME);
    expect(holder.toolNames).not.toContain("data_store.own-store.insert");
    const plain = required(await offerOf(world, chat, []));
    expect(plain.toolNames.filter((name) => name.startsWith("data_store."))).toEqual(
      readTools("own-store")
    );
  });

  it("asks the person with a card for another store, and only their click on that call adds it", async () => {
    const { world, admin, member, team, teamStore, adminsSpace, conversationOf } = await setup();
    const chat = await conversationOf(admin, adminsSpace.id);
    const { result, toolCallId } = await use(world, chat, admin, "team-figures");
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "success",
      output: { name: "team-figures", added: false, awaitsPerson: true }
    });
    expect(await listed(world, chat)).toEqual([]);
    expect(await audited(world)).toHaveLength(0);
    expect((await offerOf(world, chat, [...PLATFORM_TOOL_NAMES]))?.toolNames).not.toContain(
      "data_store.team-figures.query"
    );
    const output = outputOf(result);
    await storedCall(world, chat, admin, toolCallId, output);

    // A click that names no waiting call of this store is refused and adds nothing.
    for (const [store, call] of [
      ["team-figures", "tc_made_up"],
      ["own-store", toolCallId]
    ] as const) {
      const refused = await click(world, chat, store, call, "admin");
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json<{ error: { details?: unknown } }>().error.details).toEqual({
        reason: "data_store_use_not_pending"
      });
    }
    expect(await listed(world, chat)).toEqual([]);

    const added = await click(world, chat, "team-figures", toolCallId, "admin");
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({
      name: "team-figures",
      added: true,
      readTools: readTools("team-figures")
    });
    expect(await listed(world, chat)).toEqual(["team-figures"]);
    const events = await audited(world);
    expect(events.map((event) => event.metadata)).toEqual([
      {
        storeAssetId: teamStore.id,
        by: "card",
        confirmsToolCallId: toolCallId,
        operationRunId: expect.any(String)
      }
    ]);
    expect((await offerOf(world, chat, [...PLATFORM_TOOL_NAMES]))?.toolNames).toEqual(
      expect.arrayContaining(readTools("team-figures"))
    );

    // A call of another person's turn, even in the member's own conversation, is not theirs
    // to confirm: only the person whose turn asked may.
    const theirsChat = await conversationOf(member, team.id, "private");
    await storedCall(world, theirsChat, admin, "tc_admins_turn", output);
    const theirs = await click(world, theirsChat, "team-figures", "tc_admins_turn", "member");
    expect(theirs.statusCode, theirs.body).toBe(422);
    expect(await listed(world, theirsChat)).toEqual([]);
  });

  it("accepts a click only on a waiting data_store.use of the person's own top-level run", async () => {
    const { world, admin, adminsSpace, conversationOf } = await setup();
    const chat = await conversationOf(admin, adminsSpace.id);
    const asked = await use(world, chat, admin, "team-figures");
    const output = outputOf(asked.result);
    // The same answer stored for another tool is no waiting use.
    const elsewhere = await conversationOf(admin, adminsSpace.id);
    await storedCall(world, elsewhere, admin, "tc_other_tool", output, "data_store.describe");
    const other = await click(world, elsewhere, "team-figures", "tc_other_tool", "admin");
    expect(other.statusCode, other.body).toBe(422);
    expect(other.json<{ error: { details?: unknown } }>().error.details).toEqual({
      reason: "data_store_use_not_pending"
    });
    expect(await listed(world, elsewhere)).toEqual([]);

    const run = await storedCall(world, chat, admin, asked.toolCallId, output);
    const lineage = async (change: "subagent" | "workflow step" | "own") =>
      withTestSql(async (sql) => {
        const other = change === "subagent" ? createPlatformId("run") : null;
        await sql`
          update agent_runs
          set parent_run_id = ${other}, root_run_id = ${other},
              parent_operation_run_id = ${other === null ? null : "oprun_parent"},
              depth = ${other === null ? 0 : 1},
              workflow_step_run_id = ${change === "workflow step" ? "wsr_step" : null}
          where id = ${run.id}`;
      });
    for (const change of ["subagent", "workflow step"] as const) {
      await lineage(change);
      const refusedClick = await click(world, chat, "team-figures", asked.toolCallId, "admin");
      expect(refusedClick.statusCode, `${change}: ${refusedClick.body}`).toBe(422);
      expect(await listed(world, chat)).toEqual([]);
    }
    // The very call, as the person's own top-level turn, adds the store.
    await lineage("own");
    const added = await click(world, chat, "team-figures", asked.toolCallId, "admin");
    expect(added.statusCode, added.body).toBe(200);
    expect(await listed(world, chat)).toEqual(["team-figures"]);
  });

  it("refuses a store the person may not read as plainly as one that does not exist", async () => {
    const { world, owner, ownersSpace, conversationOf } = await setup();
    const chat = await conversationOf(owner, ownersSpace.id);
    const hidden = (await use(world, chat, owner, "team-figures")).result;
    const missing = (await use(world, chat, owner, "no-such-store")).result;
    for (const refused of [hidden, missing]) {
      expect(refused).toMatchObject({
        status: "failed",
        error: { message: "This Data Store is not available to you." }
      });
    }
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
    expect(await listed(world, chat)).toEqual([]);
  });

  it("adds no store to a conversation others read, by the tool or by a click", async () => {
    const { world, admin, team, teamStore, conversationOf } = await setup();
    const shared = await conversationOf(admin, team.id, "workspace");
    expect((await use(world, shared, admin, "team-figures")).result).toMatchObject(
      refused("start a chat of their own")
    );
    // A waiting call in it, as one asked before the tool refused here, is not confirmed either.
    await storedCall(world, shared, admin, "tc_shared", {
      name: "team-figures",
      title: "team-figures",
      added: false,
      awaitsPerson: true,
      readTools: readTools("team-figures")
    });
    const clicked = await click(world, shared, "team-figures", "tc_shared", "admin");
    expect(clicked.statusCode, clicked.body).toBe(409);
    expect(clicked.json<{ error: { details?: unknown } }>().error.details).toEqual({
      reason: "data_store_conversation_shared"
    });
    // Nor does the store write a row for it, whoever calls it.
    expect(
      await world.stores.conversations.addConversationDataStore({
        clientInstanceId,
        conversationId: shared.id,
        assetId: teamStore.id,
        addedByUserId: admin.id,
        addedAt: new Date().toISOString()
      })
    ).toBe(false);
    expect(await listed(world, shared)).toEqual([]);
    expect(await audited(world)).toHaveLength(0);

    // The admin's own conversation in the team still gets the card.
    const own = await conversationOf(admin, team.id, "private");
    expect((await use(world, own, admin, "team-figures")).result).toMatchObject({
      output: { awaitsPerson: true }
    });
  });

  it("keeps a conversation that reads a store private when it moves", async () => {
    const { world, owner, ownersSpace, team, conversationOf } = await setup();
    const chat = await conversationOf(owner, ownersSpace.id);
    expect((await use(world, chat, owner, "own-store")).result).toMatchObject({
      output: { added: true }
    });
    const move = (visibility?: ConversationVisibility) =>
      world.api.call(
        "conversations.move",
        {
          params: { conversationId: chat.id },
          payload: { collaborationWorkspaceId: team.id, ...(visibility ? { visibility } : {}) }
        },
        "owner"
      );
    const shown = await move("workspace");
    expect(shown.statusCode, shown.body).toBe(422);
    expect(shown.json<{ error: { details?: unknown } }>().error.details).toEqual({
      reason: "data_store_conversation_private"
    });
    // The store refuses it too, under the conversation's lock.
    await expect(
      world.stores.conversations.moveConversation({
        clientInstanceId,
        conversationId: chat.id,
        fromCollaborationWorkspaceId: ownersSpace.id,
        toCollaborationWorkspaceId: team.id,
        visibility: "workspace"
      })
    ).rejects.toThrow("stays private");
    const moved = await move();
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<{ visibility: string }>().visibility).toBe("private");
  });

  it("refuses every call that is not the person's own turn, before it reads anything", async () => {
    const { world, owner, ownersSpace, conversationOf } = await setup();
    const chat = await conversationOf(owner, ownersSpace.id);
    const runId = createPlatformId<"AgentRunId">("agr");
    const fence: AgentRunWriteFence = {
      runId,
      lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease" }
    };
    const key: AuthenticatedUser = { ...owner, keyScopes: ["data_store.read"] };
    const delegated: AuthenticatedUser = {
      ...owner,
      delegatedActor: { kind: "service_principal", id: "sp_1", authSource: "test" }
    };
    const turns: [string, Partial<RuntimeCallContext>, AuthenticatedUser][] = [
      ["subagent", { subagent: true }, owner],
      ["Workflow step", { workflowAgent: true }, owner],
      ["scheduled start", { unattended: true }, owner],
      ["personal key", {}, key],
      ["delegated actor", {}, delegated],
      // A worker rebuilds the actor without its key: the run's own record decides.
      ["worker run without a session", { runFence: fence }, owner]
    ];
    for (const [label, runtime, user] of turns) {
      const { result } = await use(world, chat, user, "own-store", runtime, runId);
      expect(result, label).toMatchObject(
        refused("Only the person can add a Data Store to their conversation")
      );
    }
    expect(await listed(world, chat)).toEqual([]);
    expect(await audited(world)).toHaveLength(0);
    // The person's own turn on a worker, in a session of their own, adds it.
    const own = await use(
      world,
      chat,
      owner,
      "own-store",
      { runFence: fence, firstPartyRun: true },
      runId
    );
    expect(own.result).toMatchObject({ status: "success", output: { added: true } });
  });

  it("refuses a click sent with a key", async () => {
    const { world, admin, adminsSpace, conversationOf } = await setup();
    const chat = await conversationOf(admin, adminsSpace.id);
    const asked = await use(world, chat, admin, "team-figures");
    await storedCall(world, chat, admin, asked.toolCallId, outputOf(asked.result));
    const issued = await world.api.call(
      "me.api_keys.create",
      {
        payload: {
          name: "Outside",
          scopes: ["data_store.read"],
          expiresAt: new Date(Date.now() + 86_400_000).toISOString()
        }
      },
      "admin"
    );
    expect(issued.statusCode, issued.body).toBe(200);
    const exchanged = await world.api.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${issued.json<{ secret: string }>().secret}` }
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const headers = {
      authorization: `Bearer ${exchanged.json<{ accessToken: string }>().accessToken}`
    };
    const refused = await click(world, chat, "team-figures", asked.toolCallId, { headers });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(await listed(world, chat)).toEqual([]);
  });

  it("keeps a Personal Workspace's store in its owner's own conversations, and refuses a draft", async () => {
    const { world, owner, admin, adminsSpace, team, ownStore, conversationOf } = await setup();
    const shared = await conversationOf(owner, team.id, "private");
    expect((await use(world, shared, owner, "own-store")).result).toMatchObject(
      refused("belongs to a Personal Workspace and is read only in its owner's own conversations")
    );
    expect(await listed(world, shared)).toEqual([]);
    // A row that reached a conversation outside the store's owner anyway, as a conversation
    // moved since: the offer leaves the store out.
    expect(
      await world.stores.conversations.addConversationDataStore({
        clientInstanceId,
        conversationId: shared.id,
        assetId: ownStore.id,
        addedByUserId: owner.id,
        addedAt: new Date().toISOString()
      })
    ).toBe(true);
    expect(await listed(world, shared)).toEqual(["own-store"]);
    expect(
      (await offerOf(world, shared, [...PLATFORM_TOOL_NAMES]))?.toolNames.filter((name) =>
        name.startsWith("data_store.own-store.")
      )
    ).toEqual([]);

    // A store never published has no rows to read.
    const own = await conversationOf(admin, adminsSpace.id);
    expect((await use(world, own, admin, "draft-store")).result).toMatchObject(
      refused("has not been published yet")
    );
    expect(await listed(world, own)).toEqual([]);
  });
});

describe("a run that adds a Data Store", () => {
  /**
   * One run of an agent that lists no tool of its own: the offer gives it `data_store.use`,
   * and the store's read tools once the call added the store.
   */
  async function runOf(
    answer: "added" | "awaits",
    runtimeContext: Partial<RuntimeCallContext> = {}
  ) {
    const instanceId = asClientInstanceId("store-use-runtime");
    const context: RuntimeCallContext = {
      clientInstanceId: instanceId,
      correlationId: "store-use-runtime",
      user: {
        id: "user-1",
        externalUserId: "user-1",
        displayLabel: "User",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId: instanceId,
        authSource: "test"
      },
      ...runtimeContext
    };
    const store = (await createTestInstance()).stores;
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId: instanceId,
      messages: []
    });
    const provider: ModelProviderConfig = { id: "test", type: "deterministic", model: "test" };
    let added = false;
    const used = {
      name: "findings",
      title: "Findings",
      added: answer === "added",
      ...(answer === "awaits" ? { awaitsPerson: true as const } : {}),
      readTools: readTools("findings")
    };
    const tool = createDataStoreUseTool({ useDataStore: async () => used });
    const requests: ModelCompletionRequest[] = [];
    const toolsOf = (request: ModelCompletionRequest | undefined) =>
      (request?.tools ?? []).flatMap((offered) => ("name" in offered ? [offered.name] : []));
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              name: "helper",
              displayName: "Helper",
              instructions: "Answer from the records.",
              modelProviderId: provider.id,
              toolNames: [],
              skillNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [provider],
        defaultModelProvider: provider,
        conversationHistory: store.conversations,
        conversationOffer: {
          offerOf: async () => ({
            toolNames: [DATA_STORE_USE_TOOL_NAME, ...(added ? readTools("findings") : [])],
            skillNames: []
          })
        },
        dataTools: {
          describe: async (names) =>
            names
              .filter((name) => name.startsWith("data_store.findings."))
              .map((name) => ({
                name,
                effect: "reading" as const,
                description: name,
                inputJsonSchema: {}
              }))
        },
        modelProvider: {
          id: provider.id,
          async complete(request: ModelCompletionRequest) {
            requests.push(request);
            const offered = toolsOf(request);
            if (requests.length === 1 && offered.includes(DATA_STORE_USE_TOOL_NAME))
              return {
                text: "",
                toolCalls: [
                  {
                    toolCallId: "use_1",
                    toolName: DATA_STORE_USE_TOOL_NAME,
                    input: { name: "findings" }
                  }
                ],
                usage: noReportedUsage()
              };
            if (requests.length === 2 && offered.includes("data_store.findings.query"))
              return {
                text: "",
                toolCalls: [
                  {
                    toolCallId: "query_1",
                    toolName: "data_store.findings.query",
                    input: { sql: "select count(*) from findings" }
                  }
                ],
                usage: noReportedUsage()
              };
            return { text: "Three findings.", toolCalls: [], usage: noReportedUsage() };
          }
        },
        toolRegistry: new ToolRegistry({ tools: [tool] }),
        runTool: async (request) => {
          if (request.toolName === DATA_STORE_USE_TOOL_NAME) {
            added = answer === "added";
            return tool.execute(tool.inputSchema.parse(request.input), context);
          }
          return { status: "success", output: { rows: [{ count: 3 }] } };
        },
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );
    const run = await runtime.start(
      { agentName: "helper", conversationId, message: { text: "How many findings?" } },
      context
    );
    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "run_completed" || event.type === "run_failed") break;
    }
    return { requests: requests.map(toolsOf) };
  }

  it("offers the store's read tools within the same turn, without a new message", async () => {
    const { requests } = await runOf("added");
    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain(DATA_STORE_USE_TOOL_NAME);
    expect(requests[0]).not.toContain("data_store.findings.query");
    expect(requests[1]).toEqual(expect.arrayContaining(readTools("findings")));
  });

  it("ends the turn when the store waits for the person's click", async () => {
    const { requests } = await runOf("awaits");
    expect(requests).toHaveLength(1);
  });

  it("offers no subagent the tool that adds a store", async () => {
    const { requests } = await runOf("added", { subagent: true });
    expect(requests[0]).not.toContain(DATA_STORE_USE_TOOL_NAME);
  });
});

describe("the Data Store card", () => {
  const answer = {
    name: "team-figures",
    title: "Team figures",
    added: false,
    awaitsPerson: true,
    readTools: readTools("team-figures")
  };
  const render = (node: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(createElement(TranslationProvider, { locale: "de", children: node }));

  it("reads the tool's answer and stands in the thread", () => {
    expect(readDataStoreUse({ output: answer })).toEqual({
      name: "team-figures",
      title: "Team figures",
      added: false
    });
    expect(readDataStoreUse({ message: "refused" })).toBeUndefined();
    expect(
      isDataStoreUseCall({ type: "tool-call", toolName: DATA_STORE_USE_TOOL_NAME, result: answer })
    ).toBe(true);
  });

  it("asks in German and shows the store once added", () => {
    const use = required(readDataStoreUse(answer));
    const open = render(
      createElement(DataStoreUseCardView, { use, state: "open", onConfirm: () => undefined })
    );
    expect(open).toContain("„Team figures“ in diesem Chat lesen?");
    expect(open).toContain("Erlauben");
    const added = render(createElement(DataStoreUseCardView, { use, state: "added" }));
    expect(added).toContain('data-state="added"');
    expect(added).toContain("„Team figures“ wird in diesem Chat gelesen.");
    expect(added).not.toContain("Erlauben");
  });

  it("offers no add in an embedding host's session and says where it is done", () => {
    const use = required(readDataStoreUse(answer));
    const embedded = render(
      createElement(
        EmbeddedSessionProvider,
        { user: { embedded: true }, children: null },
        createElement(DataStoreUseCardView, { use, state: "open" })
      )
    );
    expect(embedded).toContain("„Team figures“ in diesem Chat lesen?");
    expect(embedded).toContain("Das kannst nur du erlauben, in der eigenen App des Chats.");
    expect(embedded).not.toContain("Erlauben</button>");
    expect(embedded).not.toContain("<button");
  });
});
