import { agentRunProjectionSchema } from "@work-shape/catalyst-api-contract";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asMessageId,
  asToolCallId,
  createPlatformId,
  projectAgentRun,
  createAssistantToolCallsMetadata,
  createToolResultMetadata,
  type AgentRuntimeEvent,
  type RunObservation
} from "@work-shape/catalyst-core";
import { toolResultFromOperationResult } from "@work-shape/catalyst-tool-execution";
import type { PartState } from "@assistant-ui/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  ConnectionConnectCardView,
  ConnectionGiveCardView,
  connectCardOfProposal,
  connectCardOfRefusal,
  giveTools,
  planGive,
  readBuildRefusal,
  readConnectionOffer,
  readConnectionProposal,
  withOwnSignIn,
  type ConnectCardState,
  type ConnectionDraft,
  type ConnectionGiveSource,
  type ConnectionSignIn,
  type GiveAgent,
  type GivePlan,
  type GiveTool
} from "@work-shape/catalyst-chat-ui/build-area";
import {
  createAssistantMessageGroupBy,
  createCompletedAssistantWorkIndices,
  readCompatiblePersistedToolResult,
  toUiMessages
} from "./support/chat-ui/chat-assistant";
import { createTranslationContext } from "./support/chat-ui/shared";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Connect card in the conversation (CHAT-CONN-2b): its state from the agent's proposal of a
// catalogue entry or an OAuth Connection, and from a call of a personal Connection refused for a
// missing sign-in (CS-9a), which carries the card without any proposal. The refusal reaches the
// host with the Connection's name, title and catalogue link only, never an account or a token.

const ACCOUNT = "felix@example.test";
const TOKEN = "ya29.secret-access-token";

function entryProposal(answer: Record<string, unknown>): ConnectionDraft {
  const draft = readConnectionProposal({
    output: {
      entry: { id: "gmail", part: "tools" },
      connection: {
        connectorType: "http_api",
        name: "gmail",
        title: "Gmail",
        credentialMode: "user",
        headerNames: []
      },
      ...answer
    }
  });
  if (!draft) throw new Error("Expected a proposal");
  return draft;
}

describe("the Connect card's state from a proposal", () => {
  it.each([
    [{ state: "ready", bindingState: "not_connected" }, "connect"],
    [{ state: "ready", bindingState: "needs_reconnect" }, "reconnect"],
    [{ state: "ready", bindingState: "connected" }, "connected"],
    [{ state: "needs_setup", mayWrite: true }, "setup"],
    [{ state: "needs_setup", mayWrite: false }, "ask_admin"]
  ] as const)("%j shows %s", (answer, expected) => {
    expect(connectCardOfProposal(entryProposal(answer), false)?.state).toBe(expected);
  });

  it("asks the host who may set it up where the answer does not say", () => {
    const draft = entryProposal({ state: "needs_setup" });
    expect(connectCardOfProposal(draft, true)?.state).toBe("setup");
    expect(connectCardOfProposal(draft, false)?.state).toBe("ask_admin");
  });

  it("calls a shared Connection that is set up connected: there is nothing of the person's own", () => {
    const draft = entryProposal({ state: "ready" });
    draft.connection.credentialMode = "shared";
    expect(connectCardOfProposal(draft, true)).toEqual({
      name: "gmail",
      title: "Gmail",
      personal: false,
      state: "connected"
    });
  });

  it("covers an OAuth proposal, and leaves a proposal with a key to the dialog's card", () => {
    const oauth = readConnectionProposal({
      output: {
        state: "needs_setup",
        mayWrite: true,
        connection: {
          connectorType: "http_api",
          name: "crm",
          title: "CRM",
          url: "https://crm.example.test/api",
          authScheme: "oauth",
          credentialMode: "user",
          headerNames: []
        }
      }
    });
    const keyed = readConnectionProposal({
      output: {
        connection: {
          connectorType: "mcp",
          name: "brain",
          title: "Brain",
          url: "https://brain.example.test/mcp",
          keyHeader: "x-brain-key",
          headerNames: []
        }
      }
    });
    expect(oauth && connectCardOfProposal(oauth, true)?.state).toBe("setup");
    expect(keyed && connectCardOfProposal(keyed, true)).toBeUndefined();
  });
});

describe("the Connect card in place of a refused call", () => {
  const refusal = {
    status: "failed" as const,
    runId: createPlatformId<"OperationRunId">("operation"),
    error: {
      code: "CONFLICT",
      message: "connection_not_connected: connect under Settings > You > Verbindungen",
      details: {
        reason: "connection_not_connected",
        state: "not_connected",
        connection: {
          name: "gmail",
          title: "Gmail",
          service: "gmail",
          catalogue: { entry: "gmail", part: "tools", version: 1 },
          account: ACCOUNT
        },
        token: TOKEN
      }
    }
  };
  const names = {
    toolName: "connection.gmail.listMessages",
    agentName: "assistant",
    correlationId: "c1",
    locale: "de" as const
  };

  it("carries the Connection to connect beside the refusal, and nothing of an account", () => {
    const result = toolResultFromOperationResult({ result: refusal }, names);
    expect(result).toMatchObject({
      status: "failed",
      // The agent reads the refusal's own code and that the person connects from the card.
      error: {
        code: "connection_not_connected",
        message: expect.stringContaining("Karte zum Verbinden") as unknown
      },
      connect: {
        state: "not_connected",
        agentName: "assistant",
        connection: {
          name: "gmail",
          title: "Gmail",
          service: "gmail",
          catalogue: { entry: "gmail", part: "tools" }
        }
      }
    });
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${ACCOUNT}|${TOKEN}|Settings`, "u"));
  });

  it("names the ended sign-in to the agent by the refusal's own code", () => {
    const ended = {
      ...refusal,
      error: {
        ...refusal.error,
        details: { ...refusal.error.details, reason: "connection_needs_reconnect" }
      }
    };
    const result = toolResultFromOperationResult(
      {
        result: {
          ...ended,
          error: { ...ended.error, details: { ...ended.error.details, state: "needs_reconnect" } }
        }
      },
      { ...names, locale: "en" }
    );
    expect(result.status === "success" ? undefined : result.error).toMatchObject({
      code: "connection_needs_reconnect",
      message: expect.stringContaining("Gmail") as unknown
    });
  });

  it("carries nothing for any other refusal", () => {
    const other = {
      ...refusal,
      error: { ...refusal.error, details: { reason: "operation_disabled" } }
    };
    const result = toolResultFromOperationResult({ result: other }, names);
    expect("connect" in result).toBe(false);
  });

  it.each([
    ["not_connected", "connect"],
    ["needs_reconnect", "reconnect"]
  ] as const)("shows %s as %s, live and after the thread is read again", (state, expected) => {
    const connect = {
      connection: { name: "gmail", title: "Gmail", service: "gmail" },
      state,
      agentName: "assistant"
    };
    // Live: the run's projection keeps it on the failed call.
    const projection = agentRunProjectionSchema.parse(
      projectAgentRun(run(), [
        observe({
          type: "tool_call_failed",
          runId: asAgentRunId("run_1"),
          sequence: 1,
          createdAt: "2026-10-23T10:00:01.000Z",
          toolCallId: asToolCallId("call_1"),
          toolName: names.toolName,
          result: { status: "failed", error: { code: "handler_failed", message: "x" }, connect },
          modelOutput: "x"
        })
      ])
    );
    const part = projection.parts.find((entry) => entry.type === "tool_call");
    expect(part && "connect" in part ? part.connect : undefined).toEqual(connect);
    expect(connectCardOfRefusal({ status: "failed", connect })?.state).toBe(expected);
    // Stored: the tool message's result keeps it.
    const stored = readCompatiblePersistedToolResult({
      role: "tool",
      metadata: {
        agentRuntime: {
          version: 1,
          kind: "tool_result",
          runId: "run_1",
          toolCallId: "call_1",
          toolName: names.toolName,
          input: {},
          result: { status: "failed", error: { code: "handler_failed", message: "x" }, connect },
          modelOutput: "x"
        }
      }
    });
    expect(connectCardOfRefusal(stored?.output)).toEqual({
      name: "gmail",
      title: "Gmail",
      service: "gmail",
      personal: true,
      state: expected,
      agentName: "assistant"
    });
  });

  it("stands in the thread: it does not fold into the work, during the run or after it", () => {
    const connect = {
      connection: { name: "gmail", title: "Gmail" },
      state: "not_connected" as const
    };
    const parts = [
      { type: "tool-call", toolName: names.toolName, result: { status: "failed" }, isError: true },
      { type: "tool-call", toolName: names.toolName, result: { status: "failed", connect } },
      { type: "text", text: "Verbinde Gmail." }
    ];
    expect(createCompletedAssistantWorkIndices(parts, 2)).toEqual([0]);
    const groupBy = createAssistantMessageGroupBy();
    const call = (result: unknown): PartState => ({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: names.toolName,
      args: {},
      argsText: "{}",
      result,
      isError: true,
      status: { type: "complete" }
    });
    expect(groupBy(call({ status: "failed", connect }), {})).toEqual([]);
    expect(groupBy(call({ status: "failed" }), {})).not.toEqual([]);
  });

  it("reaches the thread as the part's output, which an errored part would drop", () => {
    const connect = {
      connection: { name: "gmail", title: "Gmail" },
      state: "not_connected" as const
    };
    const toolCall = { toolCallId: "call_1", toolName: names.toolName, input: {} };
    const base = { conversationId: "conv_1", clientInstanceId: "client_1", text: "" };
    const [assistant] = toUiMessages([
      {
        ...base,
        id: "msg_calls",
        role: "assistant",
        createdAt: "2026-10-23T10:00:00.000Z",
        metadata: createAssistantToolCallsMetadata({ runId: "run_1", toolCalls: [toolCall] })
      },
      {
        ...base,
        id: "msg_result",
        role: "tool",
        createdAt: "2026-10-23T10:00:01.000Z",
        metadata: createToolResultMetadata({
          runId: "run_1",
          toolCall,
          result: { status: "failed", error: { code: "handler_failed", message: "x" }, connect },
          modelOutput: { text: "x" }
        })
      }
    ]);
    const part = assistant?.parts.find((entry) => entry.type === "dynamic-tool");
    expect(part).toMatchObject({
      state: "output-available",
      output: { status: "failed", connect }
    });
  });

  it("is no card for a failed call without it", () => {
    expect(connectCardOfRefusal({ status: "failed", error: { code: "handler_failed" } })).toBe(
      undefined
    );
    expect(connectCardOfRefusal(undefined)).toBeUndefined();
  });
});

describe("the Connect card as the person's own sign-in stands now", () => {
  const card = { name: "gmail", title: "Gmail", personal: true, state: "connect" as const };

  it("says connected once the person connected, and sign in again once refused", () => {
    expect(withOwnSignIn(card, "connected").state).toBe("connected");
    expect(withOwnSignIn(card, "needs_reconnect").state).toBe("reconnect");
    expect(withOwnSignIn({ ...card, state: "connected" }, "not_connected").state).toBe("connect");
    expect(withOwnSignIn(card, undefined).state).toBe("connect");
  });

  it("asks a viewer who may not use the Connection to ask the administration", () => {
    expect(withOwnSignIn(card, "unusable")).toMatchObject({ state: "ask_admin", unusable: true });
    expect(withOwnSignIn({ ...card, state: "connected" }, "unusable").state).toBe("ask_admin");
  });

  it("leaves a card that is not about the person's own sign-in", () => {
    expect(withOwnSignIn({ ...card, state: "ask_admin" }, "connected").state).toBe("ask_admin");
    expect(withOwnSignIn({ ...card, personal: false, state: "setup" }, "connected").state).toBe(
      "setup"
    );
  });
});

describe("the Connect card", () => {
  const nothing = () => undefined;
  const signIn: ConnectionSignIn = {
    state: { phase: "idle" },
    offered: [],
    ticked: new Set(),
    choosesScopes: false,
    entersClient: false,
    personal: true,
    busy: false,
    client: { id: "", secret: "" },
    setTicked: nothing,
    setClient: nothing,
    open: nothing,
    connect: nothing,
    cancel: nothing,
    retry: nothing,
    saveClient: nothing
  };
  const render = (state: ConnectCardState, account?: string, unusable?: boolean) =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ConnectionConnectCardView, {
          title: "Gmail",
          name: "gmail",
          state,
          signIn,
          onSetup: () => Promise.resolve("opened" as const),
          ...(account ? { account } : {}),
          ...(unusable ? { unusable } : {})
        })
      )
    );

  it("names the account only once connected, and offers no button to whoever asks the administration", () => {
    expect(render("connect")).toContain("<button");
    expect(render("connect")).not.toContain("@");
    expect(render("connected", ACCOUNT)).toContain(ACCOUNT);
    expect(render("ask_admin")).not.toContain("<button");
    expect(render("ask_admin", undefined, true)).not.toContain("<button");
  });

  it("leads with the service's mark, not the title's initial, when it knows the service", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ConnectionConnectCardView, {
          title: "My mail",
          name: "my-mail",
          service: "gmail",
          state: "connect"
        })
      )
    );
    expect(markup).toContain('data-connection-icon="gmail"');
  });
});

function run() {
  return {
    id: asAgentRunId("run_1"),
    clientInstanceId: asClientInstanceId("client_1"),
    conversationId: asConversationId("conversation_1"),
    ownerUserId: "user_1",
    inputMessageId: asMessageId("message_input"),
    agentName: "assistant",
    status: "completed" as const,
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:02.000Z",
    completedAt: "2026-10-23T10:00:02.000Z",
    lastSequence: 1,
    correlationId: "correlation_1"
  };
}

function observe(event: AgentRuntimeEvent): RunObservation {
  return {
    clientInstanceId: asClientInstanceId("client_1"),
    runId: event.runId,
    conversationId: asConversationId("conversation_1"),
    ownerUserId: "user_1",
    sequence: event.sequence,
    type: event.type,
    payload: event,
    createdAt: event.createdAt
  };
}

describe("Give a Connection's tools to an agent (CS-5d)", () => {
  // "Einem Agenten geben" (CS-5d; ruling of 2026-10-24): the approved tools of a Connection go to
  // one agent after a confirmation that names the agent and the tools, as one call of
  // `agents.give_tools` over the published agent the reader read. A pending draft, anybody's,
  // changes nothing of the question and is never published by the give: the instance carries the
  // tools into it. Rights, guardrails, policy and audit are the operation's.

  const VIEWER = "user-give";

  const tools: GiveTool[] = [
    { toolName: "connection.crm.list_clients", title: "List clients" },
    { toolName: "connection.crm.get_client", title: "Get client" }
  ];

  const agent: GiveAgent = { name: "assistant", title: "Assistant" };

  type Call = {
    name: string;
    agentId: string;
    toolNames: string[];
    expectedLiveRevision: number;
  };

  /** A source over one agent at live revision 4, which records every give. */
  function fakeSource(options: { toolNames?: string[]; refused?: unknown; waits?: boolean }) {
    const calls: Call[] = [];
    const source: ConnectionGiveSource = {
      connection: async () => ({ title: "CRM", tools }),
      agents: async () => [agent],
      readAgent: async () => ({
        id: "agent-1",
        revision: 4,
        config: { instructions: "Help.", toolNames: options.toolNames ?? ["read_skill"] }
      }),
      give: async (name, input) => {
        calls.push({ name, ...input });
        if (options.refused) throw options.refused;
        return options.waits ? "waits" : "done";
      }
    };
    return { source, calls };
  }

  function ready(plan: GivePlan): Extract<GivePlan, { status: "ready" }> {
    if (plan.status !== "ready") throw new Error(`The plan is ${plan.status}, not ready.`);
    return plan;
  }

  describe("the give of a Connection's tools to an agent", () => {
    it("gives the tools over the published agent it read, as one call", async () => {
      const { source, calls } = fakeSource({});
      const plan = ready(await planGive(source, { agent, tools }));
      expect(plan.tools.map((tool) => tool.toolName)).toEqual([
        "connection.crm.list_clients",
        "connection.crm.get_client"
      ]);
      expect(plan.draft).toBe(false);

      expect(await giveTools(source, plan)).toEqual({ status: "published" });
      expect(calls).toEqual([
        {
          name: "assistant",
          agentId: "agent-1",
          toolNames: ["connection.crm.list_clients", "connection.crm.get_client"],
          expectedLiveRevision: 4
        }
      ]);
    });

    it("asks the same question where the agent has a draft, anybody's, and says it keeps it", async () => {
      for (const draft of [{ userId: VIEWER }, { userId: "user-other", authorName: "Ada" }, {}]) {
        const { source, calls } = fakeSource({});
        const plan = ready(await planGive(source, { agent: { ...agent, draft }, tools }));
        expect(plan.draft).toBe(true);
        expect(await giveTools(source, plan)).toEqual({ status: "published" });
        expect(calls).toHaveLength(1);
      }
    });

    it("asks nothing where the published agent holds every tool already", async () => {
      const { source, calls } = fakeSource({ toolNames: tools.map((tool) => tool.toolName) });
      expect(await planGive(source, { agent, tools })).toEqual({
        status: "held",
        agent: "assistant",
        title: "Assistant"
      });
      expect(calls).toEqual([]);
    });

    it("names only the tools the published agent does not hold", async () => {
      const { source } = fakeSource({ toolNames: ["connection.crm.get_client"] });
      const plan = ready(await planGive(source, { agent, tools }));
      expect(plan.tools.map((tool) => tool.toolName)).toEqual(["connection.crm.list_clients"]);
    });

    it("says the give waits where the instance holds it for an approval", async () => {
      const { source } = fakeSource({ waits: true });
      const plan = ready(await planGive(source, { agent, tools }));
      expect(await giveTools(source, plan)).toEqual({ status: "waits" });
    });

    it("says the agent changed where the published agent moved since it was read", async () => {
      for (const code of ["REVISION_CONFLICT", "CONFLICT"]) {
        const { source } = fakeSource({ refused: { code, message: "The agent changed." } });
        const plan = ready(await planGive(source, { agent, tools }));
        expect(await giveTools(source, plan)).toEqual({ status: "changed" });
      }
    });

    it("explains a refused give with the validator's lines, as a refused save does", async () => {
      const locale = "en";
      const { t } = createTranslationContext(locale);
      const refused = {
        code: "VALIDATION_FAILED",
        payload: {
          error: {
            code: "VALIDATION_FAILED",
            message: "Config asset bundle is invalid",
            details: {
              issues: [
                {
                  message:
                    "Agent 'workshaper' references unavailable tool 'app.edit' in instructions line 46"
                },
                {
                  message:
                    "Agent 'workshaper' references unavailable tool 'app.save' in instructions line 46"
                },
                {
                  message:
                    "Agent 'workshaper' references unavailable tool 'app.edit' in instructions line 47"
                }
              ]
            }
          }
        }
      };
      const { source } = fakeSource({ refused });
      const plan = ready(await planGive(source, { agent, tools }));
      const given = await giveTools(source, plan, { t, locale });
      expect(given.status).toBe("failed");
      if (given.status !== "failed") throw new Error("Expected refused give");
      const saved = readBuildRefusal(refused, t, locale);
      if (saved.ok || saved.conflict) throw new Error("Expected refused save");
      expect(given.message).toBe(saved.refusals.map(({ message }) => message).join("\n"));
      expect(given.message).toContain("app.edit");
      expect(given.message).toContain("app.save");
      expect(given.message).not.toContain("Config asset bundle is invalid");
    });

    it("says why a give is refused", async () => {
      const { source } = fakeSource({
        refused: { code: "FORBIDDEN", message: "You may not publish this agent." }
      });
      const plan = ready(await planGive(source, { agent, tools }));
      expect(await giveTools(source, plan)).toEqual({
        status: "failed",
        message: "You may not publish this agent."
      });
    });
  });

  describe("the offer in the conversation", () => {
    it("reads the Connection and the agent the agent named, and nothing else", () => {
      expect(
        readConnectionOffer({ output: { connection: "crm", agent: "assistant", extra: "x" } })
      ).toEqual({ connection: "crm", agent: "assistant" });
      expect(readConnectionOffer({ output: { connection: "crm" } })).toEqual({ connection: "crm" });
      expect(readConnectionOffer({ output: {} })).toBeUndefined();
    });

    function card(withHost: boolean) {
      const { source } = fakeSource({});
      return renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { children: null, locale: "en" },
          createElement(ConnectionGiveCardView, {
            offer: { connection: "crm", agent: "assistant" },
            ...(withHost ? { host: { source, viewerId: VIEWER } } : {}),
            read: { status: "ready", connection: { title: "CRM", tools } }
          })
        )
      );
    }

    it("offers the give only where the place has a host for it", () => {
      expect(card(true)).toContain("data-connection-give=");
      expect(card(false)).not.toContain("data-connection-give=");
    });
  });
});
