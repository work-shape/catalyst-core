import { createElement } from "react";
import type { SafeConfig } from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import {
  agentListStatus,
  AgentsPage,
  agentStudioRoute,
  agentsRowShown,
  areaOfRoute,
  railSections,
  shownRailSections,
  startNewAgent,
  workspaceRouteFromPath,
  workspaceRoutePath,
  type AgentsPageProps
} from "@work-shape/catalyst-chat-ui/agents";
import {
  clearBuildStartRequest,
  requestedBuildStart
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Agents page: its address, its row in the rail, and what a card shows of an agent to a
// member and to a builder. Every test here fails without the page: the module it reads did
// not exist, and the route table and the rail had no row for it.

type Agent = SafeConfig["agents"][number];

function agent(overrides: Partial<Agent> & Pick<Agent, "name" | "displayName">): Agent {
  return { selectableModels: [], initialPrompts: [], ...overrides };
}

const tax = agent({
  name: "tax.vat-helper",
  displayName: "Steuer-Assistent",
  description: "Beantwortet Fragen zur Umsatzsteuer.",
  initialPrompts: [
    { title: "Vorsteuer prüfen", prompt: "Prüfe die Vorsteuer dieser Rechnung: " },
    { title: "Frist nennen", prompt: "Wann ist die Voranmeldung fällig?" },
    { title: "Reverse Charge", prompt: "Erkläre Reverse Charge für " },
    { title: "Vierter Vorschlag", prompt: "Der vierte Vorschlag." }
  ]
});
const helpdesk = agent({ name: "helpdesk", displayName: "Helpdesk" });

const noop = () => undefined;

function page(overrides: Partial<AgentsPageProps> = {}): string {
  return renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale: "en",
      children: createElement(AgentsPage, {
        agents: [tax, helpdesk],
        defaultAgentName: "helpdesk",
        status: "ready",
        onRetry: noop,
        onStartChat: noop,
        ...overrides
      })
    })
  );
}

/** The markup of one agent's card: from its list item to the end of that item. */
function card(markup: string, displayName: string): string {
  const found = markup
    .split('<li class="flex min-w-0"><div data-card="" data-padding')
    .slice(1)
    .find((part) => part.includes(`>${displayName}</h2>`));
  if (found === undefined) {
    throw new Error(`No card of ${displayName}.`);
  }
  return found;
}

describe("the address of the Agents page", () => {
  it("is the workspace's own, and an area of its own", () => {
    const route = { kind: "agents", collaborationWorkspaceId: "cw_1" } as const;

    expect(workspaceRoutePath(route)).toBe("/w/cw_1/agents");
    expect(workspaceRouteFromPath("/w/cw_1/agents")).toEqual(route);
    expect(areaOfRoute(route)).toBe("agents");
    // A conversation's address is not mistaken for it, nor the other way round.
    expect(workspaceRouteFromPath("/w/cw_1/c/agents")).toEqual({
      kind: "conversation",
      collaborationWorkspaceId: "cw_1",
      conversationId: "agents"
    });
  });

  it("leads an agent to its page in Studio, with the id as written", () => {
    expect(workspaceRoutePath(agentStudioRoute("tax.vat-helper"))).toBe(
      "/build/agents/tax.vat-helper"
    );
    expect(workspaceRoutePath(agentStudioRoute("a/b c"))).toBe("/build/agents/a%2Fb%20c");
  });
});

describe("the Agents row of the rail", () => {
  it("stands first, before Apps and the Inbox, in a session with workspaces", () => {
    const ids = (given: Parameters<typeof shownRailSections>[1]) =>
      shownRailSections(railSections, given).map((section) => section.id);

    expect(ids({ agents: true, apps: true, inbox: { toDecide: 2 } })).toEqual([
      "agents",
      "apps",
      "inbox"
    ]);
    // An embedded session has no workspace whose agents the page could show.
    expect(ids({ apps: true })).toEqual(["apps"]);

    // NAV-VIS-1: the workspace's list names the row with two agents or more, or for whoever may
    // write one. With one agent New chat starts it, and the row is gone.
    const named = { visibleSections: ["agents" as const] };
    const unnamed = { visibleSections: [] };

    expect(agentsRowShown(true, named)).toBe(true);
    expect(agentsRowShown(true, unnamed)).toBe(false);
    // Until the list arrived, or where it failed, nothing is known to show.
    expect(agentsRowShown(true, undefined)).toBe(false);
    // An embedded session has no workspace whose agents the page could show.
    expect(agentsRowShown(false, named)).toBe(false);
  });
});

describe("the state of the workspace's list of agents", () => {
  it("waits for the list, says when it failed, and shows it once it is there", () => {
    expect(agentListStatus({ loaded: false, failed: false })).toBe("loading");
    expect(agentListStatus({ loaded: false, failed: true })).toBe("failed");
    expect(agentListStatus({ loaded: true, failed: false })).toBe("ready");
    // A list that is there stays, also when asking for it again failed.
    expect(agentListStatus({ loaded: true, failed: true })).toBe("ready");
  });
});

describe("the Agents page", () => {
  it("shows a member each agent with its description and Start chat, and nothing of Studio", () => {
    const markup = page();
    const taxCard = card(markup, "Steuer-Assistent");
    expect(taxCard).toContain("Beantwortet Fragen zur Umsatzsteuer.");
    // The starter prompts wait in the empty chat with the agent, not on its card.
    expect(taxCard).not.toContain("Vorsteuer prüfen");
    // The whole card starts the chat: Start chat is its one target.
    expect(taxCard).toMatch(/<button[^>]*data-card-target=""[^>]*>Start chat<\/button>/u);
    expect(markup).not.toContain("/build/");
    expect(markup).not.toContain("tax.vat-helper");
    // The workspace's default agent is marked, and no other.
    expect(card(markup, "Helpdesk")).toContain("Default agent");
    expect(taxCard).not.toContain("Default agent");
  });

  it("gives a builder a link to the agent's page in Studio, beside the card's own target", () => {
    const taxCard = card(page({ onOpenStudio: noop }), "Steuer-Assistent");
    expect(taxCard).toMatch(/<a[^>]*href="\/build\/agents\/tax\.vat-helper"/u);
    expect(taxCard).not.toMatch(/<a[^>]*data-card-target/u);
  });

  it("offers New agent to a person who may create one, and to nobody else", () => {
    const newAgent = {
      mayChooseAll: true,
      startsIn: { workspace: { id: "cws_1", name: "Steuer" }, mayChooseAll: true },
      checkName: async () => ({ available: true as const }),
      onStart: noop
    };
    expect(page({ onOpenStudio: noop, newAgent })).toContain("New agent");
    expect(page({ agents: [], onOpenStudio: noop, newAgent })).toContain("New agent");
    expect(page({ onOpenStudio: noop })).not.toContain("New agent");
    expect(page()).not.toContain("New agent");
  });

  it("opens the new agent that the page's dialog started on the list of agents in Studio", () => {
    const opened: string[] = [];
    const start = { name: "helper", title: "Helper" };
    try {
      startNewAgent((route) => opened.push(workspaceRoutePath(route)), start);

      expect(opened).toEqual(["/build/agents"]);
      expect(requestedBuildStart("agents")).toEqual(start);
      expect(requestedBuildStart("skills")).toBeUndefined();
    } finally {
      clearBuildStartRequest();
    }
  });

  it("writes an agent's own words as text, never as markup", () => {
    const hostile = agent({
      name: "x",
      displayName: '<img src=x onerror="alert(1)">',
      description: "</p><script>alert(2)</script>"
    });
    const markup = page({ agents: [hostile] });

    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;/p&gt;&lt;script&gt;");
  });

  it("leads only a builder of a workspace without agents to Studio", () => {
    expect(page({ agents: [] })).not.toContain("/build/agents");
    expect(page({ agents: [], onOpenStudio: noop })).toMatch(/<a[^>]*href="\/build\/agents"/u);
  });

  it("shows no agent while the list loads or after it failed", () => {
    expect(page({ status: "loading", agents: [helpdesk] })).not.toContain("Helpdesk");
    const failed = page({ status: "failed", agents: [helpdesk] });
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain("Helpdesk");
  });
});
