import { describe, expect, it } from "vitest";
import {
  PLATFORM_TOOL_NAMES,
  createLogger,
  createPlatformTools,
  platformModules
} from "@work-shape/catalyst-client-assembly";
import {
  createEgressChecker,
  createMcpConnectorType,
  createOwnServerTools
} from "@work-shape/catalyst-connections";
import {
  asToolCallId,
  asUserId,
  createAuthorizer,
  createConnectorTypeRegistry,
  createModuleRegistry,
  createPlatformId,
  createUserPrincipal,
  type AgentRun,
  type AuthenticatedUser,
  type Conversation,
  type ToolExecutionContext,
  type UserRecord
} from "@work-shape/catalyst-core";
import { CONNECTION_PROPOSE_TOOL_NAME } from "@work-shape/catalyst-tool-execution";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// The own-server mode of `platform.connections.propose` (PMCP-CHAT, connections acceptance checks
// 86 and 92). Any agent, not only one that holds the platform's tools, may propose a person's own
// MCP server in a run that person started themself in a chat, while their own servers are on and
// they hold `connection.add_own`; in a chat others read the answer says `privateChat: false`.
// The card opens their add screen, and the tool saves nothing. Its audit names the mode, never
// the address or the name.

const ADDRESS = "https://notes.example.com/mcp";

/** An agent as its definition lists it: with no tool of the platform, or with one. */
const AGENTS: Record<string, { toolNames: string[]; ownServers?: boolean }> = {
  helper: { toolNames: [] },
  closed: { toolNames: [], ownServers: false },
  builder: { toolNames: PLATFORM_TOOL_NAMES.slice(0, 1) },
  lister: { toolNames: ["platform.connections.propose"] }
};

async function setup(options: { ownServersOn?: boolean } = {}) {
  const t = await setupAccessInstance({ modules: { connections: { enabled: true } } });
  const connectorTypes = createConnectorTypeRegistry([createMcpConnectorType()]);
  const ownServerTools = createOwnServerTools({
    clientInstanceId,
    stores: t.stores,
    connectorTypes,
    egress: createEgressChecker({ allow: [] }),
    credentials: undefined,
    logger: createLogger(),
    ownServers: { enabled: options.ownServersOn ?? true }
  });
  const runs = new Map<string, AgentRun>();
  const platform = createPlatformTools({
    stores: {
      conversations: t.stores.conversations,
      configAssets: t.stores.configAssets,
      workspaces: t.stores.workspaces,
      agentRuns: { getAgentRun: async ({ runId }) => runs.get(runId) }
    },
    modules: createModuleRegistry(platformModules).snapshot({ connections: { enabled: true } }),
    connections: { connectorTypes, ownServerTools },
    authorizer: createAuthorizer(t.stores.access),
    agentOf: async (name) => AGENTS[name]
  });
  platform.registry(platform.tools, new Set());
  const tool = platform.tools.find((candidate) => candidate.name === CONNECTION_PROPOSE_TOOL_NAME);
  if (!tool) throw new Error("No proposal tool");
  const home = (
    await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(t.kai.id)
    })
  ).id;
  return { t, runs, tool, offer: platform.conversationOffer, home };
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

function runOf(chat: Conversation, user: UserRecord, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: createPlatformId<"AgentRunId">("run"),
    clientInstanceId,
    conversationId: chat.id,
    ownerUserId: user.id,
    inputMessageId: createPlatformId<"MessageId">("msg"),
    agentName: "helper",
    authorization: {
      personalConnectionsAllowed: true,
      principal: createUserPrincipal(personOf(user)),
      subjectUserId: user.id,
      scopes: ["*"]
    },
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSequence: 0,
    correlationId: "corr_own_server_propose",
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

/** The call of the tool in `run`, by `agentName`, as the runtime makes it. */
function callIn(
  run: AgentRun,
  user: AuthenticatedUser,
  agentName = run.agentName,
  overrides: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  return {
    clientInstanceId,
    correlationId: "corr_own_server_propose",
    user,
    toolRequest: {
      toolName: CONNECTION_PROPOSE_TOOL_NAME,
      toolCallId: asToolCallId(createPlatformId("toolcall")),
      agentRunId: run.id,
      conversationId: run.conversationId,
      agentName,
      input: {}
    },
    ...overrides
  };
}

const ownServerProposal = (overrides: Record<string, unknown> = {}) => ({
  mode: "own_server",
  connectorType: "mcp",
  title: "Meine Notizen",
  url: ADDRESS,
  ...overrides
});

describe("an agent's proposal of a person's own MCP server", () => {
  it("is offered to any agent in a chat its person started the run in, and nowhere else", async () => {
    const { t, runs, offer, home } = await setup();
    const record = (run: AgentRun) => (runs.set(run.id, run), run);
    const proposes = async (run: AgentRun, user: AuthenticatedUser, agent = "helper") =>
      (
        await offer.offerOf({
          clientInstanceId,
          conversationId: run.conversationId,
          agentToolNames: AGENTS[agent]?.toolNames ?? [],
          agentOwnServers: AGENTS[agent]?.ownServers !== false,
          user,
          runId: run.id
        })
      )?.toolNames ?? [];
    const kai = personOf(t.kai);
    const lena = personOf(t.lena);
    const own = record(runOf(await chatOf(t, t.kai, home), t.kai));
    expect(await proposes(own, kai)).toContain(CONNECTION_PROPOSE_TOOL_NAME);

    // The agent keeps own servers out.
    expect(await proposes(own, kai, "closed")).not.toContain(CONNECTION_PROPOSE_TOOL_NAME);
    const team = await t.sharedWorkspace("Team");
    for (const user of [t.kai, t.lena]) {
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: asUserId(user.id),
        role: "member"
      });
    }
    // A chat the team reads (PMCP-CHAT-2): its person's run, also a teammate's run in a chat
    // another person started, is offered the proposal; the server's own tools stay out.
    const teamChat = await chatOf(t, t.kai, team);
    expect(await proposes(record(runOf(teamChat, t.kai)), kai)).toContain(
      CONNECTION_PROPOSE_TOOL_NAME
    );
    expect(await proposes(record(runOf(teamChat, t.lena)), lena)).toContain(
      CONNECTION_PROPOSE_TOOL_NAME
    );
    // Another person for the run, a subagent, a Workflow step, a key: none, in any chat.
    const keyActor = {
      kind: "api_key" as const,
      id: createPlatformId<"ApiCredentialId">("key"),
      displayLabel: "Key",
      authSource: "test"
    };
    const teamRun = record(runOf(teamChat, t.kai));
    const refused: [string, AgentRun, AuthenticatedUser][] = [
      ["another person for the run", own, lena],
      ["another person for a team chat's run", teamRun, lena],
      [
        "a subagent",
        record(runOf(await chatOf(t, t.kai, home), t.kai, { parentRunId: own.id })),
        kai
      ],
      [
        "a subagent in a team chat",
        record(runOf(teamChat, t.kai, { parentRunId: teamRun.id })),
        kai
      ],
      [
        "a Workflow step",
        record(runOf(await chatOf(t, t.kai, home), t.kai, { workflowStepRunId: "wfstep_1" })),
        kai
      ],
      [
        "a Workflow step in a team chat",
        record(runOf(teamChat, t.kai, { workflowStepRunId: "wfstep_2" })),
        kai
      ],
      ["the owner's key", own, personOf(t.kai, { delegatedActor: keyActor, keyScopes: ["*"] })],
      [
        "the owner's key in a team chat",
        teamRun,
        personOf(t.kai, { delegatedActor: keyActor, keyScopes: ["*"] })
      ],
      [
        "a run its key started",
        record(
          runOf(teamChat, t.kai, {
            authorization: {
              personalConnectionsAllowed: false,
              principal: createUserPrincipal(kai),
              subjectUserId: t.kai.id,
              scopes: ["*"]
            }
          })
        ),
        kai
      ]
    ];
    for (const [what, run, user] of refused) {
      expect(await proposes(run, user), what).not.toContain(CONNECTION_PROPOSE_TOOL_NAME);
    }
    // An agent that holds the platform's tools keeps the tool for its other modes.
    expect(await proposes(refused[0]?.[1] ?? own, lena, "builder")).toContain(
      CONNECTION_PROPOSE_TOOL_NAME
    );
  });

  it("answers in a team chat that the server's tools work only in private chats", async () => {
    const { t, runs, tool } = await setup();
    const team = await t.sharedWorkspace("Team");
    for (const user of [t.kai, t.lena]) {
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: asUserId(user.id),
        role: "member"
      });
    }
    const teamChat = await chatOf(t, t.kai, team);
    const privateChat = await chatOf(t, t.kai, team, "private");
    for (const [what, run, user] of [
      ["the chat's creator", runOf(teamChat, t.kai), t.kai],
      ["a teammate", runOf(teamChat, t.lena), t.lena]
    ] as const) {
      runs.set(run.id, run);
      const answer = await tool.execute(
        tool.inputSchema.parse(ownServerProposal()),
        callIn(run, personOf(user), "builder")
      );
      expect(answer.status, what).toBe("success");
      const output = answer.status === "success" ? answer.output : undefined;
      expect(output, what).toMatchObject({
        mode: "own_server",
        ownServer: { title: "Meine Notizen", url: ADDRESS },
        privateChat: false
      });
      expect(JSON.stringify(output), what).toContain("only in the person's private chats");
      expect(tool.outputSchema?.parse(output), what).toEqual(output);
      // The audit names the mode alone, as in a private chat.
      if (answer.status === "success") {
        expect(answer.auditSummary).toEqual({
          action: CONNECTION_PROPOSE_TOOL_NAME,
          metadata: { mode: "own_server" }
        });
      }
    }
    // Her private chat in the team workspace is hers alone.
    const own = runOf(privateChat, t.kai);
    runs.set(own.id, own);
    const answer = await tool.execute(
      tool.inputSchema.parse(ownServerProposal()),
      callIn(own, personOf(t.kai))
    );
    expect(answer.status === "success" ? answer.output : undefined).toEqual({
      mode: "own_server",
      ownServer: { title: "Meine Notizen", url: ADDRESS },
      privateChat: true
    });
  });

  it("is not offered while own servers are off or to a person without connection.add_own", async () => {
    const off = await setup({ ownServersOn: false });
    const offRun = runOf(await chatOf(off.t, off.t.kai, off.home), off.t.kai);
    off.runs.set(offRun.id, offRun);
    const offered = await off.offer.offerOf({
      clientInstanceId,
      conversationId: offRun.conversationId,
      agentToolNames: [],
      agentOwnServers: true,
      user: personOf(off.t.kai),
      runId: offRun.id
    });
    expect(offered?.toolNames).not.toContain(CONNECTION_PROPOSE_TOOL_NAME);
    const call = await off.tool.execute(ownServerProposal(), callIn(offRun, personOf(off.t.kai)));
    expect(call.status).toBe("failed");

    const { t, runs, offer, tool, home } = await setup();
    await t.expectOk(t.root.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "connection.add_own",
        scopeKind: "instance",
        effect: "deny"
      }
    });
    const run = runOf(await chatOf(t, t.kai, home), t.kai);
    runs.set(run.id, run);
    const denied = await offer.offerOf({
      clientInstanceId,
      conversationId: run.conversationId,
      agentToolNames: [],
      agentOwnServers: true,
      user: personOf(t.kai),
      runId: run.id
    });
    expect(denied?.toolNames).not.toContain(CONNECTION_PROPOSE_TOOL_NAME);
    expect((await tool.execute(ownServerProposal(), callIn(run, personOf(t.kai)))).status).toBe(
      "failed"
    );
  });

  it("answers the card with the name and the address, saves nothing, and audits the mode alone", async () => {
    const { t, runs, tool, home } = await setup();
    const run = runOf(await chatOf(t, t.kai, home), t.kai);
    runs.set(run.id, run);
    const connections = () =>
      t.stores.configAssets.listPublishedConfigAssets({
        clientInstanceId,
        kind: "connection",
        limit: 100
      });
    const before = await connections();
    const parsed = tool.inputSchema.parse(ownServerProposal({ url: ` ${ADDRESS} ` }));
    const answer = await tool.execute(parsed, callIn(run, personOf(t.kai)));
    expect(answer).toEqual({
      status: "success",
      output: {
        mode: "own_server",
        ownServer: { title: "Meine Notizen", url: ADDRESS },
        privateChat: true
      },
      auditSummary: { action: CONNECTION_PROPOSE_TOOL_NAME, metadata: { mode: "own_server" } }
    });
    expect(tool.outputSchema?.parse(answer.status === "success" ? answer.output : {})).toEqual({
      mode: "own_server",
      ownServer: { title: "Meine Notizen", url: ADDRESS },
      privateChat: true
    });
    expect(await connections()).toEqual(before);
    // No audit record names the address or the name.
    expect(JSON.stringify(answer.auditSummary)).not.toContain("notes.example.com");
    expect(JSON.stringify(answer.auditSummary)).not.toContain("Meine Notizen");

    // The mode takes the type, the name and the address, and nothing else.
    for (const extra of [
      { connection: "notes" },
      { authScheme: "oauth" },
      { keyHeader: "x-api-key" },
      { connectorType: "http_api" }
    ]) {
      expect(
        tool.inputSchema.safeParse(ownServerProposal(extra)).success,
        JSON.stringify(extra)
      ).toBe(false);
    }
  });

  it("refuses an address with credentials, a query or a fragment, or not https", async () => {
    const { t, runs, tool, home } = await setup();
    const run = runOf(await chatOf(t, t.kai, home), t.kai);
    runs.set(run.id, run);
    for (const url of [
      "https://me:secret@notes.example.com/mcp",
      "https://notes.example.com/mcp?key=sk-live-1",
      "https://notes.example.com/mcp#token",
      "http://notes.example.com/mcp",
      "notes.example.com/mcp"
    ]) {
      const answer = await tool.execute(
        tool.inputSchema.parse(ownServerProposal({ url })),
        callIn(run, personOf(t.kai))
      );
      expect(answer.status, url).toBe("failed");
      if (answer.status === "failed") {
        expect(answer.error.code).toBe("validation_failed");
        expect(answer.auditSummary).toEqual({
          action: CONNECTION_PROPOSE_TOOL_NAME,
          metadata: { mode: "own_server" }
        });
      }
    }
  });

  it("is refused at the call outside a run its person started, even to an agent with the platform's tools", async () => {
    const { t, runs, tool, home } = await setup();
    const team = await t.sharedWorkspace("Team");
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.kai.id),
      role: "member"
    });
    const kai = personOf(t.kai);
    const shared = runOf(await chatOf(t, t.kai, team), t.kai, { agentName: "builder" });
    const own = runOf(await chatOf(t, t.kai, home), t.kai);
    runs.set(shared.id, shared);
    runs.set(own.id, own);
    const refusedCalls: [string, ToolExecutionContext][] = [
      ["an agent that keeps own servers out", callIn(own, kai, "closed")],
      ["a subagent's call", callIn(own, kai, "helper", { subagent: true })],
      ["a subagent's call in a team chat", callIn(shared, kai, "builder", { subagent: true })],
      ["a Workflow agent's call", callIn(own, kai, "helper", { workflowAgent: true })],
      ["an unattended start", callIn(own, kai, "helper", { unattended: true })],
      ["another person", callIn(own, personOf(t.lena))],
      ["another person in a team chat", callIn(shared, personOf(t.lena), "builder")]
    ];
    for (const [what, context] of refusedCalls) {
      const answer = await tool.execute(tool.inputSchema.parse(ownServerProposal()), context);
      expect(answer.status, what).toBe("failed");
      if (answer.status === "failed") expect(answer.error.code, what).toBe("not_allowed");
    }
  });

  it("gives an agent without the platform's tools no other mode", async () => {
    const { t, runs, tool, home } = await setup();
    const run = runOf(await chatOf(t, t.kai, home), t.kai);
    runs.set(run.id, run);
    const shared = tool.inputSchema.parse({
      connectorType: "mcp",
      connection: "notes",
      title: "Notes",
      url: ADDRESS
    });
    const answer = await tool.execute(shared, callIn(run, personOf(t.kai)));
    expect(answer.status).toBe("failed");
    if (answer.status === "failed") expect(answer.error.code).toBe("not_allowed");
    // An agent that holds them, or lists the tool itself, proposes as before.
    expect((await tool.execute(shared, callIn(run, personOf(t.kai), "builder"))).status).toBe(
      "success"
    );
    expect((await tool.execute(shared, callIn(run, personOf(t.kai), "lister"))).status).toBe(
      "success"
    );
  });
});
