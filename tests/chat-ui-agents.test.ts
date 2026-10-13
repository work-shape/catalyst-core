import { createElement } from "react";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import {
  agentListStatus,
  AgentsPage,
  agentStudioRoute,
  areaOfRoute,
  railSections,
  shownRailSections,
  startNewAgent,
  workspaceRouteFromPath,
  workspaceRoutePath,
  type AgentsPageProps
} from "@vivd-catalyst/chat-ui/agents";
import { clearBuildStartRequest, requestedBuildStart } from "@vivd-catalyst/chat-ui/build-area";
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

function page(overrides: Partial<AgentsPageProps> = {}, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale,
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
    .split('<li class="flex min-w-0"><div data-padding')
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

    expect(ids({ agents: true })).toEqual(["agents"]);
    expect(ids({ agents: true, apps: true, inbox: { toDecide: 2 } })).toEqual([
      "agents",
      "apps",
      "inbox"
    ]);
    // An embedded session has no workspace whose agents the page could show.
    expect(ids({ apps: true })).toEqual(["apps"]);
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
  it("shows a member each agent with its mark, its description and Start chat", () => {
    const markup = page();
    const taxCard = card(markup, "Steuer-Assistent");

    expect(markup).toContain('<h1 class="min-w-0 break-words outline-none text-title-lg">Agents');
    expect(markup).toContain("The agents of this workspace. Start a chat with one.");
    // The agent mark stands where the initials stood.
    expect(taxCard).toMatch(/<span aria-hidden="true" data-kind="agent"[^>]*><svg[^>]*lucide-bot/u);
    expect(taxCard).not.toContain(">SA</span>");
    // What the agent does, in two lines at most.
    expect(taxCard).toMatch(
      /<p class="line-clamp-2[^"]*">Beantwortet Fragen zur Umsatzsteuer.<\/p>/u
    );
    // The starter prompts wait in the empty chat with the agent, not on its card.
    expect(taxCard).not.toContain("Vorsteuer prüfen");
    expect(taxCard).not.toContain("Reverse Charge");
    expect(markup).not.toContain('aria-label="Suggestions"');
    expect(taxCard).toMatch(/<button[^>]*aria-describedby="[^"]+"[^>]*>Start chat<\/button>/u);
    // Nothing is edited here, and a member is not led to Studio.
    expect(markup).not.toContain("Edit in Studio");
    expect(markup).not.toContain("/build/");
    expect(markup).not.toContain("tax.vat-helper");
  });

  it("marks the workspace's default agent and no other", () => {
    const markup = page();

    expect(card(markup, "Helpdesk")).toContain("Default agent");
    expect(card(markup, "Steuer-Assistent")).not.toContain("Default agent");
    expect(page({ defaultAgentName: undefined })).not.toContain("Default agent");
  });

  it("leaves out a description an agent does not have, with no placeholder", () => {
    const helpdeskCard = card(page(), "Helpdesk");

    // The agent mark is drawn with <path>: a paragraph is "<p" and a space or the tag's end.
    expect(helpdeskCard).not.toMatch(/<p[ >]/u);
    expect(helpdeskCard).toContain(">Start chat</button>");
    // A description of spaces is none.
    expect(card(page({ agents: [{ ...helpdesk, description: "   " }] }), "Helpdesk")).not.toMatch(
      /<p[ >]/u
    );
  });

  it("gives a builder a link to the agent's page in Studio, named by the agent", () => {
    const taxCard = card(page({ onOpenStudio: noop }), "Steuer-Assistent");

    expect(taxCard).toMatch(
      /<a[^>]*href="\/build\/agents\/tax\.vat-helper"[^>]*aria-describedby="[^"]+"[^>]*>Edit in Studio<\/a>/u
    );
  });

  it("offers New agent in the page head to a person who may create one, and to nobody else", () => {
    const button = /<button[^>]*>(?:<svg.*?<\/svg>)?New agent<\/button>/u;
    const newAgent = { namespaces: [], mayNameFreely: true, onStart: noop };

    expect(page({ onOpenStudio: noop, newAgent })).toMatch(button);
    expect(page({ agents: [], onOpenStudio: noop, newAgent })).toMatch(button);
    expect(page({ newAgent }, "de")).toContain("Neuer Agent</button>");
    // The dialog opens on this page once the button is pressed, not before.
    expect(page({ newAgent })).not.toContain('id="build-create-form"');
    // A builder who may read agents and not create one keeps the links and gets no button.
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

  it("tells a member of a workspace without agents who can change that, without an action", () => {
    const markup = page({ agents: [] });

    expect(markup).toContain(
      "No agent is available in this workspace yet. An administrator can make one available here."
    );
    expect(markup).not.toContain("Open Studio");
    expect(markup).not.toContain("<ul");
  });

  it("tells a builder of a workspace without agents where one is made, with the way there", () => {
    const markup = page({ agents: [], onOpenStudio: noop });

    expect(markup).toContain(
      "No agent is available in this workspace yet. Create one in Studio, or make an existing one available here."
    );
    expect(markup).toMatch(/<a[^>]*href="\/build\/agents"[^>]*>Open Studio<\/a>/u);
  });

  it("shows no card and no empty sentence while the list loads", () => {
    const markup = page({ status: "loading", agents: [helpdesk] });

    expect(markup).not.toContain("Helpdesk");
    expect(markup).not.toContain("No agent is available");
    expect(markup).toContain(">Agents</h1>");
  });

  it("says that the list failed and offers to ask again, without the instance's agents", () => {
    const markup = page({ status: "failed", agents: [helpdesk] });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The agents could not be loaded.");
    expect(markup).toContain(">Try again</button>");
    expect(markup).not.toContain("Helpdesk");
  });

  it("reads in German", () => {
    const markup = page({ onOpenStudio: noop }, "de");

    expect(markup).toContain(">Agenten</h1>");
    expect(markup).toContain(">Chat starten</button>");
    expect(markup).toContain(">Im Studio bearbeiten</a>");
    expect(markup).toContain("Standardagent");
    expect(markup).toContain(
      "Die Agenten dieses Arbeitsbereichs. Starte einen Chat mit einem von ihnen."
    );
    expect(page({ agents: [], onOpenStudio: noop }, "de")).toContain(">Studio öffnen</a>");
  });
});
