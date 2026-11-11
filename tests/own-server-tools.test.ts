import { describe, expect, it } from "vitest";
import {
  conversationToolNames,
  createLogger,
  createPlatformTools,
  platformModules
} from "@work-shape/catalyst-client-assembly";
import {
  createConnectionOperationSource,
  createEgressChecker,
  createMcpConnectorType,
  createOwnServerTools,
  ownServerPolicyFloor,
  type ConnectionOperationSourceDeps,
  type OwnServerFloorDeps
} from "@work-shape/catalyst-connections";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  asUserId,
  createConnectorTypeRegistry,
  createModuleRegistry,
  createPlatformId,
  createUserPrincipal,
  resolvePolicy,
  type AgentRun,
  type AuthenticatedUser,
  type Conversation,
  type ConversationId,
  type JsonValue,
  type OperationOrigin,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { connection, fixtureConnectionKind } from "./support/connections";

// The tools of a person's own MCP server (PMCP-4, connections acceptance check 80). Such a
// server is on no agent: its accepted tools join the runs its owner starts in their own private
// chats, where the agent lets them in (`ownServers`), and nobody else's. A changing tool asks
// before every call and a reading tool asks where another Connection's operation ran in the
// chat; an admin's `allow` and a person's "Always allow" lower neither.

const KAI_NOTES = "kai_notes";
const SEARCH = `connection.${KAI_NOTES}.search`;
const SAVE = `connection.${KAI_NOTES}.save`;
const LENA_SEARCH = "connection.lena_notes.search";

const ops = (...names: [string, "reading" | "changing", string[], boolean?][]): JsonValue[] =>
  names.map(([name, effect, exposure, enabled]) => ({
    name,
    effect,
    exposure,
    enabled: enabled ?? true
  }));

/** A server a person added for themselves, as PMCP-2 stores it. */
function ownServer(name: string, owner: UserRecord, overrides: Record<string, JsonValue> = {}) {
  return connection(name, {
    connectorType: "mcp",
    authScheme: "oauth",
    credentialMode: "user",
    secretHandle: undefined,
    ownerOnly: true,
    ownerPrincipalId: owner.id,
    origin: "runtime",
    settings: { url: "https://notes.example.com/mcp" },
    operations: ops(["search", "reading", ["agent"]]),
    ...overrides
  });
}

async function setup(options: { ownServersOn?: boolean } = {}) {
  const t = await setupAccessInstance({
    modules: { connections: { enabled: true } },
    furtherKinds: [fixtureConnectionKind()]
  });
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "connection",
        name: KAI_NOTES,
        config: ownServer(KAI_NOTES, t.kai, {
          operations: ops(
            ["search", "reading", ["agent"]],
            ["save", "changing", ["agent"]],
            // Accepted and switched off: no agent is offered it.
            ["export", "reading", ["agent"], false]
          )
        })
      },
      {
        type: "upsert",
        kind: "connection",
        name: "lena_notes",
        config: ownServer("lena_notes", t.lena)
      },
      // Kai's, switched off.
      {
        type: "upsert",
        kind: "connection",
        name: "kai_paused",
        config: ownServer("kai_paused", t.kai, { enabled: false })
      },
      // An admin's Connection of the instance.
      { type: "upsert", kind: "connection", name: "crm", config: connection("crm") }
    ]
  });
  const deps: ConnectionOperationSourceDeps = {
    clientInstanceId,
    stores: t.stores,
    connectorTypes: createConnectorTypeRegistry([createMcpConnectorType()]),
    egress: createEgressChecker({ allow: [] }),
    credentials: undefined,
    logger: createLogger(),
    ownServers: { enabled: options.ownServersOn ?? true }
  };
  const ownServerTools = createOwnServerTools(deps);
  const runs = new Map<string, AgentRun>();
  const platform = createPlatformTools({
    stores: {
      conversations: t.stores.conversations,
      configAssets: t.stores.configAssets,
      workspaces: t.stores.workspaces,
      agentRuns: { getAgentRun: async ({ runId }) => runs.get(runId) }
    },
    modules: createModuleRegistry(platformModules).snapshot({}),
    connections: { connectorTypes: deps.connectorTypes, ownServerTools }
  });
  platform.registry(platform.tools, new Set());
  const home = (
    await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(t.kai.id)
    })
  ).id;
  return { t, deps, ownServerTools, runs, offer: platform.conversationOffer, home };
}

function personOf(user: UserRecord, overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: user.id,
    externalUserId: user.id,
    displayLabel: user.displayLabel,
    roles: ["user"],
    permissionRefs: [],
    clientInstanceId,
    authSource: "test",
    ...overrides
  };
}

/** A run's record of its start: by the person themself, in their own session. */
function authorizationOf(user: UserRecord): NonNullable<AgentRun["authorization"]> {
  return {
    personalConnectionsAllowed: true,
    principal: createUserPrincipal(personOf(user)),
    subjectUserId: user.id,
    scopes: ["*"]
  };
}

function runOf(chat: Conversation, user: UserRecord, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: createPlatformId<"AgentRunId">("run"),
    clientInstanceId,
    conversationId: chat.id,
    ownerUserId: user.id,
    inputMessageId: createPlatformId<"MessageId">("msg"),
    agentName: "assistant",
    authorization: authorizationOf(user),
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSequence: 0,
    correlationId: "corr_own_servers",
    ...overrides
  };
}

function chatOf(
  t: AccessInstance,
  user: UserRecord,
  workspaceId: Conversation["collaborationWorkspaceId"],
  visibility: Conversation["visibility"] = "workspace"
) {
  return t.stores.conversations.createConversation({
    clientInstanceId,
    collaborationWorkspaceId: workspaceId,
    createdByUserId: user.id,
    createdByExternalUserId: user.id,
    visibility,
    title: "Chat",
    retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
  });
}

const agentOrigin = (conversationId: ConversationId, toolName = SEARCH): OperationOrigin => ({
  kind: "agent",
  agentName: "assistant",
  agentRunId: asAgentRunId("run_own"),
  conversationId,
  toolCallId: asToolCallId(createPlatformId("toolcall")),
  toolName
});

describe("the tools of a person's own MCP server", () => {
  it("are the owner's switched-on servers' agent tools, and none while the operator's switch is off", async () => {
    const { t, ownServerTools } = await setup();
    expect(await ownServerTools.toolNamesOf(t.kai.id)).toEqual([SEARCH, SAVE]);
    expect(await ownServerTools.toolNamesOf(t.lena.id)).toEqual([LENA_SEARCH]);
    expect(await ownServerTools.toolNamesOf(t.admin.id)).toEqual([]);
    expect(
      await ownServerTools.ownServerToolNames([
        SEARCH,
        LENA_SEARCH,
        "connection.crm.echo",
        "run_agent"
      ])
    ).toEqual([SEARCH, LENA_SEARCH]);

    const off = await setup({ ownServersOn: false });
    expect(await off.ownServerTools.toolNamesOf(off.t.kai.id)).toEqual([]);
  });

  it("are offered to the owner's own run in their private chat where the agent lets them in", async () => {
    const { t, runs, offer, home } = await setup();
    const team = await t.sharedWorkspace("Team");
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.kai.id),
      role: "member"
    });
    const record = (run: AgentRun) => (runs.set(run.id, run), run);
    const offered = async (
      run: AgentRun,
      user: AuthenticatedUser,
      agent: { toolNames?: string[]; ownServers?: boolean } = { ownServers: true }
    ) => {
      const answer = await offer.offerOf({
        clientInstanceId,
        conversationId: run.conversationId,
        agentToolNames: agent.toolNames ?? [],
        ...(agent.ownServers === undefined ? {} : { agentOwnServers: agent.ownServers }),
        user,
        runId: run.id
      });
      return {
        offered: (answer?.toolNames ?? []).filter((name) => name.startsWith("connection.")),
        withheld: answer?.withheldToolNames ?? [],
        callable: (await conversationToolNames(agent.toolNames ?? [], answer)).filter((name) =>
          name.startsWith("connection.")
        )
      };
    };
    const kai = personOf(t.kai);
    const own = record(runOf(await chatOf(t, t.kai, home), t.kai));

    expect(await offered(own, kai)).toEqual({
      offered: [SEARCH, SAVE],
      withheld: [],
      callable: [SEARCH, SAVE]
    });
    // A private chat of his in a Shared Workspace is his alone too.
    const teamPrivate = record(runOf(await chatOf(t, t.kai, team, "private"), t.kai));
    expect((await offered(teamPrivate, kai)).offered).toEqual([SEARCH, SAVE]);

    // The agent turned them off, or says nothing (a caller that does not say offers none).
    expect(await offered(own, kai, { ownServers: false })).toEqual({
      offered: [],
      withheld: [],
      callable: []
    });
    expect((await offered(own, kai, {})).offered).toEqual([]);
    // An agent that lists one anyway is withheld it, and no call of the run may make it.
    expect(
      await offered(own, kai, {
        toolNames: [SEARCH, LENA_SEARCH, "connection.crm.echo"],
        ownServers: false
      })
    ).toEqual({
      offered: [],
      withheld: [SEARCH, LENA_SEARCH],
      callable: ["connection.crm.echo"]
    });
    // Where it lets them in, only another person's listed tool is withheld.
    expect(await offered(own, kai, { toolNames: [SEARCH, LENA_SEARCH], ownServers: true })).toEqual(
      { offered: [SEARCH, SAVE], withheld: [LENA_SEARCH], callable: [SEARCH, SAVE] }
    );

    // A chat with a named person.
    const shared = await chatOf(t, t.kai, team, "private");
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.lena.id),
      role: "member"
    });
    await t.stores.conversations.addConversationPerson({
      clientInstanceId,
      conversationId: shared.id,
      userId: t.lena.id,
      addedByUserId: t.kai.id,
      addedAt: new Date().toISOString(),
      checked: { dataStoreAssetIds: [] }
    });
    const keyActor = {
      kind: "api_key" as const,
      id: createPlatformId<"ApiCredentialId">("key"),
      displayLabel: "Key",
      authSource: "test"
    };
    const refused: [string, AgentRun, AuthenticatedUser][] = [
      ["a chat with a named person", record(runOf(shared, t.kai)), kai],
      ["a chat the team reads", record(runOf(await chatOf(t, t.kai, team), t.kai)), kai],
      [
        "another person's run",
        record(runOf(await chatOf(t, t.kai, home), t.lena)),
        personOf(t.lena)
      ],
      ["another person for the owner's run", own, personOf(t.lena)],
      [
        "a subagent",
        record(runOf(await chatOf(t, t.kai, home), t.kai, { parentRunId: own.id })),
        kai
      ],
      [
        "a Workflow step",
        record(runOf(await chatOf(t, t.kai, home), t.kai, { workflowStepRunId: "wfstep_1" })),
        kai
      ],
      [
        "a run started outside a session",
        record(
          runOf(await chatOf(t, t.kai, home), t.kai, {
            authorization: { ...authorizationOf(t.kai), personalConnectionsAllowed: false }
          })
        ),
        kai
      ],
      ["the owner's key", own, personOf(t.kai, { delegatedActor: keyActor, keyScopes: ["*"] })],
      ["a run the store does not hold", runOf(await chatOf(t, t.kai, home), t.kai), kai]
    ];
    for (const [what, run, user] of refused) {
      expect(await offered(run, user), what).toEqual({ offered: [], withheld: [], callable: [] });
    }
    // Lena's own chat offers Lena's server, never Kai's.
    const lenaHome = (
      await t.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(t.lena.id)
      })
    ).id;
    const lenaRun = record(runOf(await chatOf(t, t.lena, lenaHome), t.lena));
    expect(
      await offered(lenaRun, personOf(t.lena), { toolNames: [SEARCH], ownServers: true })
    ).toEqual({
      offered: [LENA_SEARCH],
      withheld: [SEARCH],
      callable: [LENA_SEARCH]
    });
  });

  it("asks before every change, and before a read where another Connection ran, whatever an admin or the person allows", async () => {
    const { t, deps, home } = await setup();
    const chat = await chatOf(t, t.kai, home);
    const source = createConnectionOperationSource(deps);
    const floorOf = async (name: string, origin: OperationOrigin) => {
      const definition = await source.resolve(name);
      if (!definition) throw new Error(`No operation '${name}'`);
      return definition.policyFloorOf?.(origin, {}, undefined);
    };
    const record = async (
      operation: string,
      conversationId: ConversationId,
      status: "done" | "pending"
    ) => {
      const now = new Date().toISOString();
      const run = await t.stores.operationRuns.create({
        id: createPlatformId("oprun"),
        clientInstanceId,
        operation,
        effect: "reading",
        actor: { kind: "user", id: t.kai.id, label: "Kai" },
        origin: agentOrigin(conversationId, operation),
        conversationId,
        target: "live",
        inputHash: createPlatformId("hash"),
        correlationId: "corr_own_floor",
        startedAt: now
      });
      if (!run) throw new Error("No run was created");
      await t.stores.operationRuns.finish({
        clientInstanceId,
        id: run.id,
        end:
          status === "done"
            ? { status: "done", finishedAt: now }
            : {
                status: "pending_confirmation",
                finishedAt: now,
                expiresAt: "2999-01-01T00:00:00.000Z"
              }
      });
    };

    // A change asks from every origin.
    expect(await floorOf(SAVE, agentOrigin(chat.id, SAVE))).toBe("confirm");
    expect(await floorOf(SAVE, { kind: "cli" })).toBe("confirm");
    // A read asks nothing while only this server ran in the chat.
    expect(await floorOf(SEARCH, agentOrigin(chat.id))).toBeUndefined();
    await record(SEARCH, chat.id, "done");
    expect(await floorOf(SEARCH, agentOrigin(chat.id))).toBeUndefined();
    // Another Connection's call that only waits did not run.
    await record("connection.crm.echo", chat.id, "pending");
    expect(await floorOf(SEARCH, agentOrigin(chat.id))).toBeUndefined();
    await record("connection.crm.echo", chat.id, "done");
    expect(await floorOf(SEARCH, agentOrigin(chat.id))).toBe("confirm");
    // Another chat is not this one.
    expect(await floorOf(SEARCH, agentOrigin((await chatOf(t, t.kai, home)).id))).toBeUndefined();
    // An admin's own Connection keeps no such floor.
    expect(
      await floorOf("connection.crm.echo", agentOrigin(chat.id, "connection.crm.echo"))
    ).toBeUndefined();

    // The floor is applied last: an admin's `allow` and the person's "Always allow" do not lower
    // it, and an admin's `deny` still raises it.
    const resolved = (
      policyFloor: "confirm",
      effect: "reading" | "changing",
      value: "allow" | "deny"
    ) =>
      resolvePolicy({
        definition: { name: SAVE, effect, policyFloor },
        origin: agentOrigin(chat.id, SAVE),
        instanceDefaults: { reading: "allow", changing: "allow" },
        centralSettings: [{ operation: `connection.${KAI_NOTES}.*`, value }],
        person: { setting: "always_allow", mayAlwaysAllow: true },
        callerCanConfirm: true,
        canPause: true
      }).value;
    expect(resolved("confirm", "changing", "allow")).toBe("confirm");
    expect(resolved("confirm", "reading", "allow")).toBe("confirm");
    expect(resolved("confirm", "changing", "deny")).toBe("deny");
  });

  it("asks before a read where another Connection ran in a run thread, and where that cannot be read", async () => {
    const chat = asConversationId("conv_chat");
    const thread = asConversationId("conv_thread");
    const conversations = new Map<
      ConversationId,
      Pick<Conversation, "id" | "kind" | "parentConversationId">
    >([
      [chat, { id: chat, kind: "chat" }],
      [thread, { id: thread, kind: "run_thread", parentConversationId: chat }]
    ]);
    let ran: string[] = [];
    let readFails = false;
    const deps: OwnServerFloorDeps = {
      clientInstanceId,
      stores: {
        conversations: {
          getConversation: async (_, id) => conversations.get(id)
        },
        operationRuns: {
          connectionOperationsIn: async ({ conversationId }) => {
            if (readFails) throw new Error("The store is down");
            return conversationId === chat ? ran : [];
          }
        }
      }
    };
    const read = { effect: "reading" as const };
    const floor = (conversationId: ConversationId) =>
      ownServerPolicyFloor(deps, KAI_NOTES, read, agentOrigin(conversationId));

    ran = [SEARCH];
    expect(await floor(thread)).toBeUndefined();
    ran = [SEARCH, "connection.crm.echo"];
    // The subagent's call in its thread asks after the chat's other read.
    expect(await floor(thread)).toBe("confirm");
    expect(await floor(chat)).toBe("confirm");
    // A read of a Workflow or of a page asks nothing more than the Connection does.
    expect(
      await ownServerPolicyFloor(deps, KAI_NOTES, read, {
        kind: "workflow",
        workflowRunId: createPlatformId("wfrun"),
        stepRunId: "step"
      })
    ).toBeUndefined();
    // Unknown conversations and failed reads ask.
    ran = [];
    expect(await floor(asConversationId("conv_gone"))).toBe("confirm");
    conversations.set(asConversationId("conv_orphan"), {
      id: asConversationId("conv_orphan"),
      kind: "run_thread"
    });
    expect(await floor(asConversationId("conv_orphan"))).toBe("confirm");
    readFails = true;
    expect(await floor(chat)).toBe("confirm");
  });

  it("is refused on an agent's save, and its delete is never refused by an agent that lists it", async () => {
    const { t } = await setup();
    const refusal = await t.call(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "helper" },
      payload: {
        config: {
          name: "helper",
          displayName: "Helper",
          instructions: "Help.",
          modelProviderId: "local",
          toolNames: [SEARCH]
        },
        expectedRevision: null
      }
    });
    expect(refusal.statusCode, refusal.body).toBe(422);
    expect(refusal.body).toContain("own_server_tool_on_agent");
    expect(refusal.body).toContain("a tool of an MCP server a person added for themselves");

    // An agent that lists it from before is no reason to keep it.
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "legacy",
          config: {
            name: "legacy",
            displayName: "Legacy",
            instructions: "Help.",
            modelProviderId: "local",
            toolNames: [SEARCH]
          }
        }
      ]
    });
    const stored = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: KAI_NOTES
    });
    const removed = await t.call(t.admin.id, "assets.delete", {
      params: { kind: "connection", name: KAI_NOTES },
      payload: { expectedRevision: stored?.revision ?? null }
    });
    expect(removed.statusCode, removed.body).toBe(200);
  });
});
