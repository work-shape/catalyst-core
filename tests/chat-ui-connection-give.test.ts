import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { AgentDraft } from "@work-shape/catalyst-api-client";
import {
  ConnectionApprovedBody,
  ConnectionGiveCardView,
  giveTools,
  planGive,
  readConnectionOffer,
  withGivenTools,
  type ConnectionGiveSource,
  type GiveAgent,
  type GivePlan,
  type GiveTool
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// "Einem Agenten geben" (CS-5d; manager's ruling of 2026-10-19): the approved tools of a
// Connection go to one agent as one published revision, after a confirmation that names the
// agent and the tools. Somebody else's draft is never written; the reader's own draft takes the
// tools and is published only where the reader confirms publishing the whole draft. The give is
// the agent page's own save and publish, so rights, policy and audit are theirs.

const VIEWER = "user-give";
const OTHER = "user-other";

const tools: GiveTool[] = [
  { toolName: "connection.crm.list_clients", title: "List clients" },
  { toolName: "connection.crm.get_client", title: "Get client" }
];

const agent: GiveAgent = { name: "assistant", title: "Assistant" };

function draftBy(userId: string, toolNames: string[], name = "Ada Example"): AgentDraft {
  return {
    agent: "assistant",
    revision: 7,
    baseRevision: 4,
    liveRevision: 4,
    stale: false,
    config: { instructions: "Help.", toolNames },
    author: { userId, name, displayLabel: name, release: false },
    updatedAt: "2026-10-19T09:00:00.000Z"
  };
}

type Call =
  | {
      op: "save";
      config: Record<string, unknown>;
      liveRevision: number;
      draftRevision: number | null;
    }
  | { op: "publish"; revision: number }
  | { op: "discard"; revision: number };

/** A source over one agent at live revision 4, which records every write. */
function fakeSource(options: {
  draft?: AgentDraft | null;
  /** The draft the instance answers after a save was refused. */
  draftAfterConflict?: AgentDraft | null;
  saveRefused?: unknown;
  saveWaits?: boolean;
  publishRefused?: unknown;
  publishWaits?: boolean;
}) {
  const calls: Call[] = [];
  let conflicted = false;
  const source: ConnectionGiveSource = {
    connection: async () => ({ title: "CRM", tools }),
    agents: async () => [agent],
    readAgent: async () => ({
      revision: 4,
      config: { instructions: "Help.", toolNames: ["read_skill"] }
    }),
    readDraft: async () =>
      conflicted && options.draftAfterConflict !== undefined
        ? options.draftAfterConflict
        : (options.draft ?? null),
    saveDraft: async (_name, config, expected) => {
      calls.push({ op: "save", config, ...expected });
      if (options.saveRefused) {
        conflicted = true;
        throw options.saveRefused;
      }
      return options.saveWaits ? "waits" : 9;
    },
    publish: async (_name, revision) => {
      calls.push({ op: "publish", revision });
      if (options.publishRefused) throw options.publishRefused;
      return options.publishWaits ? "waits" : "done";
    },
    discard: async (_name, revision) => {
      calls.push({ op: "discard", revision });
    }
  };
  return { source, calls };
}

function ready(plan: GivePlan): Extract<GivePlan, { status: "ready" }> {
  if (plan.status !== "ready") throw new Error(`The plan is ${plan.status}, not ready.`);
  return plan;
}

describe("the give of a Connection's tools to an agent", () => {
  it("adds the tools to the published agent and publishes it as one revision", async () => {
    const { source, calls } = fakeSource({});
    const plan = ready(await planGive(source, { agent, tools, viewerId: VIEWER }));
    expect(plan.tools.map((tool) => tool.toolName)).toEqual([
      "connection.crm.list_clients",
      "connection.crm.get_client"
    ]);
    expect(plan.now.ownDraft).toBeUndefined();

    const outcome = await giveTools(source, plan, { publishDraft: false, viewerId: VIEWER });
    expect(outcome).toEqual({ status: "published" });
    expect(calls).toEqual([
      {
        op: "save",
        config: {
          instructions: "Help.",
          toolNames: ["read_skill", "connection.crm.list_clients", "connection.crm.get_client"]
        },
        liveRevision: 4,
        draftRevision: null
      },
      { op: "publish", revision: 9 }
    ]);
  });

  it("refuses an agent with somebody else's draft, names them, and writes nothing", async () => {
    const { source, calls } = fakeSource({ draft: draftBy(OTHER, ["read_skill"]) });
    const plan = await planGive(source, { agent, tools, viewerId: VIEWER });
    expect(plan).toEqual({
      status: "other_draft",
      agent: "assistant",
      title: "Assistant",
      author: "Ada Example"
    });
    expect(calls).toEqual([]);
  });

  it("refuses a draft a release wrote as somebody else's", async () => {
    const release = draftBy(OTHER, []);
    const { source } = fakeSource({
      draft: { ...release, author: { release: true } }
    });
    expect((await planGive(source, { agent, tools, viewerId: VIEWER })).status).toBe("other_draft");
  });

  it("adds the tools to the reader's own draft and leaves it unpublished without consent", async () => {
    const { source, calls } = fakeSource({ draft: draftBy(VIEWER, ["web_fetch"]) });
    const plan = ready(await planGive(source, { agent, tools, viewerId: VIEWER }));
    expect(plan.now.ownDraft).toEqual({ revision: 7 });

    const outcome = await giveTools(source, plan, { publishDraft: false, viewerId: VIEWER });
    expect(outcome).toEqual({ status: "drafted" });
    expect(calls).toEqual([
      {
        op: "save",
        config: {
          instructions: "Help.",
          toolNames: ["web_fetch", "connection.crm.list_clients", "connection.crm.get_client"]
        },
        liveRevision: 4,
        draftRevision: 7
      }
    ]);
  });

  it("publishes the reader's whole draft where they confirm publishing it", async () => {
    const { source, calls } = fakeSource({ draft: draftBy(VIEWER, ["web_fetch"]) });
    const plan = ready(await planGive(source, { agent, tools, viewerId: VIEWER }));
    const outcome = await giveTools(source, plan, { publishDraft: true, viewerId: VIEWER });
    expect(outcome).toEqual({ status: "published" });
    expect(calls.map((call) => call.op)).toEqual(["save", "publish"]);
  });

  it("asks nothing where the agent, or the reader's draft, holds every tool already", async () => {
    const held = fakeSource({
      draft: draftBy(
        VIEWER,
        tools.map((tool) => tool.toolName)
      )
    });
    expect(await planGive(held.source, { agent, tools, viewerId: VIEWER })).toEqual({
      status: "held",
      agent: "assistant",
      title: "Assistant",
      inDraft: true
    });
    expect(held.calls).toEqual([]);
  });

  it("adds only the tools the agent does not hold", async () => {
    const { source } = fakeSource({
      draft: draftBy(VIEWER, ["connection.crm.get_client"])
    });
    const plan = ready(await planGive(source, { agent, tools, viewerId: VIEWER }));
    expect(plan.tools.map((tool) => tool.toolName)).toEqual(["connection.crm.list_clients"]);
  });

  it("discards the draft it wrote itself where the publish is refused, and says why", async () => {
    const { source, calls } = fakeSource({
      publishRefused: { code: "FORBIDDEN", message: "You may not publish this agent." }
    });
    const plan = ready(await planGive(source, { agent, tools, viewerId: VIEWER }));
    const outcome = await giveTools(source, plan, { publishDraft: false, viewerId: VIEWER });
    expect(outcome).toEqual({ status: "failed", message: "You may not publish this agent." });
    expect(calls.map((call) => call.op)).toEqual(["save", "publish", "discard"]);
    expect(calls[2]).toEqual({ op: "discard", revision: 9 });
  });

  it("keeps the reader's own draft where its publish is refused", async () => {
    const { source, calls } = fakeSource({
      draft: draftBy(VIEWER, []),
      publishRefused: { code: "FORBIDDEN", message: "No." }
    });
    const plan = ready(await planGive(source, { agent, tools, viewerId: VIEWER }));
    await giveTools(source, plan, { publishDraft: true, viewerId: VIEWER });
    expect(calls.map((call) => call.op)).toEqual(["save", "publish"]);
  });

  it("keeps the draft a publish waits for, for the approval in the Inbox", async () => {
    const { source, calls } = fakeSource({ publishWaits: true });
    const plan = ready(await planGive(source, { agent, tools, viewerId: VIEWER }));
    expect(await giveTools(source, plan, { publishDraft: false, viewerId: VIEWER })).toEqual({
      status: "waits"
    });
    expect(calls.map((call) => call.op)).toEqual(["save", "publish"]);
  });

  it("publishes nothing where the save itself waits for an approval", async () => {
    const { source, calls } = fakeSource({ saveWaits: true });
    const plan = ready(await planGive(source, { agent, tools, viewerId: VIEWER }));
    expect(await giveTools(source, plan, { publishDraft: false, viewerId: VIEWER })).toEqual({
      status: "waits"
    });
    expect(calls.map((call) => call.op)).toEqual(["save"]);
  });

  it("names the author of a draft written between the plan and the save", async () => {
    const { source, calls } = fakeSource({
      saveRefused: { code: "REVISION_CONFLICT", message: "The draft changed." },
      draftAfterConflict: draftBy(OTHER, [], "Grace Example")
    });
    const plan = ready(await planGive(source, { agent, tools, viewerId: VIEWER }));
    expect(await giveTools(source, plan, { publishDraft: false, viewerId: VIEWER })).toEqual({
      status: "other_draft",
      author: "Grace Example"
    });
    expect(calls.map((call) => call.op)).toEqual(["save"]);
  });

  it("adds each tool once, after those the definition holds", () => {
    expect(withGivenTools({ toolNames: ["a", "b"], other: 1 }, ["b", "c", "c"]).toolNames).toEqual([
      "a",
      "b",
      "c"
    ]);
    expect(withGivenTools({}, ["c"])).toEqual({ toolNames: ["c"] });
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
