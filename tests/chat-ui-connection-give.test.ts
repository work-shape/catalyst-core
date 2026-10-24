import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  ConnectionApprovedBody,
  ConnectionGiveCardView,
  giveTools,
  planGive,
  readConnectionOffer,
  type ConnectionGiveSource,
  type GiveAgent,
  type GivePlan,
  type GiveTool
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

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

  function card(locale: "en" | "de", withHost: boolean) {
    const { source } = fakeSource({});
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(ConnectionGiveCardView, {
          offer: { connection: "crm", agent: "assistant" },
          ...(withHost ? { host: { source, viewerId: VIEWER } } : {}),
          read: { status: "ready", connection: { title: "CRM", tools } }
        })
      )
    );
  }

  it("shows the tools and a button that changes nothing before the confirmation", () => {
    const en = card("en", true);
    expect(en).toContain("Tools of CRM for an agent");
    expect(en).toContain("List clients");
    expect(en).toContain("data-connection-give=");
    expect(en).toContain("Nothing changes before you confirm.");
    const de = card("de", true);
    expect(de).toContain("Tools von CRM für einen Agenten");
    expect(de).toContain("Einem Agenten geben");
  });

  it("has no button where the place offers no give", () => {
    expect(card("en", false)).not.toContain("data-connection-give=");
  });
});

describe("after the approval of a Connection's tools", () => {
  it("says no agent can use them yet and offers the give, in English and German", () => {
    const render = (locale: "en" | "de") =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { children: null, locale },
          createElement(ConnectionApprovedBody, { count: 2, onGive: () => undefined })
        )
      );
    expect(render("en")).toContain("2 tools approved.");
    expect(render("en")).toContain("No agent can use them yet.");
    expect(render("en")).toContain("Give to an agent");
    expect(render("de")).toContain("2 Tools freigegeben.");
    expect(render("de")).toContain("Einem Agenten geben");
  });
});
