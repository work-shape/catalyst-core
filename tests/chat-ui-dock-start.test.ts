import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { SafeConfig } from "@work-shape/catalyst-api-client";
import {
  agentChipDisplayFor,
  conversationStart,
  dockKindOfRoute,
  ThreadStartBlock,
  ThreadWelcomeHeading,
  BuildUnoffered,
  TRY_DOCK_KIND,
  type ConversationStart
} from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// ACCEPT-1c C6: every dock that builds or changes an asset greeted with the configured agent's
// own welcome ("How can I help with the demo workflow?") and offered its prompts ("Check
// weather"), whatever was built. The start page of such a conversation now speaks of the asset
// it is about, or of the new one of the kind beside the dock, and never of the agent's.

const noop = () => undefined;

// The demo's configured assistant, as its YAML words it.
const demoAssistant = {
  name: "workflow_assistant",
  displayName: "Workflow Assistant",
  welcomeMessage: "How can I help with the demo workflow?",
  welcomeSubtitle: "Demo subtitle",
  selectableModels: [],
  initialPrompts: [
    {
      title: "Check weather",
      prompt: "Check the weather forecast for Oslo for the next three days."
    }
  ],
  starters: [{ skillName: "generic_workflow_review", title: "Review a workflow", prompt: "Review" }]
} satisfies SafeConfig["agents"][number];

function EmptyConversation({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime({
    async run() {
      return { content: [] };
    }
  });
  return createElement(AssistantRuntimeProvider, { runtime }, children);
}

function startPage(start: ConversationStart | undefined, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(
        EmptyConversation,
        null,
        createElement(ThreadWelcomeHeading, {
          agent: demoAssistant,
          agentDisplay: agentChipDisplayFor({ showAgentName: true, showAgentDescriptions: false }),
          agents: [demoAssistant],
          showAgent: false,
          fallbackWelcomeMessage: undefined,
          start,
          onSelectAgent: noop
        }),
        createElement(ThreadStartBlock, {
          initialPrompts: demoAssistant.initialPrompts,
          starters: demoAssistant.starters,
          start,
          onStarterChosen: noop
        })
      )
    )
  );
}

type WorkspaceRoute = Parameters<typeof dockKindOfRoute>[0];

const DEMO_WORDS = ["demo workflow", "Check weather", "Oslo", "Review a workflow", "Demo subtitle"];

describe("the start page of a dock that builds", () => {
  it("knows the kind a new asset of which the list beside the dock builds", () => {
    const workspace = { collaborationWorkspaceId: "ws" };
    expect(dockKindOfRoute({ kind: "workflows", ...workspace })).toBe("workflow");
    expect(dockKindOfRoute({ kind: "apps", ...workspace })).toBe("app");
    expect(dockKindOfRoute({ kind: "build-kind", assetKind: "data_store" })).toBe("data_store");
    expect(dockKindOfRoute({ kind: "inbox" })).toBeUndefined();
    // A subject wins over the page beside the dock.
    expect(conversationStart({ kind: "app", title: "Rate card" }, "workflow")).toEqual({
      about: "asset",
      kind: "app",
      title: "Rate card"
    });
    expect(conversationStart(undefined, undefined)).toBeUndefined();
  });

  it.each([
    ["workflow", "What should the new workflow do?", "Monday task summary"],
    ["app", "What should the new app do?", "Fee calculator"],
    ["agent", "What should the new agent do?", "Answer client questions"],
    ["skill", "What should the new skill know how to do?", "Check an invoice"]
  ])("greets a new %s with its own words and examples", (kind, greeting, example) => {
    const html = startPage({ about: "new", kind });
    expect(html).toContain(greeting);
    expect(html).toContain(example);
    for (const word of DEMO_WORDS) expect(html).not.toContain(word);
  });

  it("greets a conversation about an asset by its name, in German too", () => {
    const html = startPage({ about: "asset", kind: "app", title: "Urlaubsanträge" }, "de");
    expect(html).toContain("Was soll sich an „Urlaubsanträge“ ändern?");
    expect(html).toContain("Feld hinzufügen");
    expect(html).not.toContain("Beispielworkflow");
    for (const word of DEMO_WORDS) expect(html).not.toContain(word);
  });

  // STORE-PAGES: the starters of a conversation about a store fit its kind: a store's schema,
  // a Knowledge Base's description and the agent that searches it.
  it.each([
    ["data_store", "en", ["Add a table", "Add a column"]],
    ["data_store", "de", ["Tabelle hinzufügen", "Spalte hinzufügen"]],
    ["knowledge_base", "en", ["Describe it", "Give it to an agent"]],
    ["knowledge_base", "de", ["Beschreiben", "Einem Agenten geben"]]
  ] as const)("offers starters of its own about a %s (%s)", (kind, locale, titles) => {
    const html = startPage({ about: "asset", kind, title: "Leads" }, locale);
    for (const title of titles) expect(html).toContain(title);
    for (const word of DEMO_WORDS) expect(html).not.toContain(word);
  });

  it("offers no agent prompts for an asset of a kind without starters of its own", () => {
    const html = startPage({ about: "asset", kind: "guardrail", title: "Handbook" });
    expect(html).toContain("What should change in “Handbook”?");
    for (const word of DEMO_WORDS) expect(html).not.toContain(word);
    expect(startPage({ about: "new", kind: "connection" })).toContain("What do you want to build?");
  });

  it("invites the first message of Try, in German too, with no Build greeting or prompts", () => {
    const start = conversationStart(undefined, TRY_DOCK_KIND);
    const html = startPage(start);
    expect(html).toContain("Send a message to try the agent.");
    expect(html).not.toContain("What do you want to build?");
    for (const word of DEMO_WORDS) expect(html).not.toContain(word);
    expect(startPage(start, "de")).toContain(
      "Schreib eine Nachricht, um den Agenten auszuprobieren."
    );
  });

  // An existing agent's page greeted an empty dock with "What should the new agent do?" and
  // new-agent examples: the page of an asset was read as its kind's list.
  it.each<WorkspaceRoute>([
    { kind: "build-asset", assetKind: "agents", name: "quote_bot" },
    { kind: "build-asset", assetKind: "skills", name: "check_invoice" },
    { kind: "app-edit", collaborationWorkspaceId: "ws", app: "rates" },
    { kind: "app", collaborationWorkspaceId: "ws", app: "rates" },
    { kind: "workflow", collaborationWorkspaceId: "ws", workflow: "summary" },
    { kind: "workflow-runs", collaborationWorkspaceId: "ws", workflow: "summary" }
  ])("never greets a new asset beside the page of an existing one: $kind", (route) => {
    const dockKind = dockKindOfRoute(route);
    expect(dockKind).toBeUndefined();
    expect(conversationStart(undefined, dockKind)).toBeUndefined();
    // Its conversation about the asset speaks of that asset.
    const start = conversationStart({ kind: "agent", title: "Quote bot" }, dockKind);
    const html = startPage(start, "de");
    expect(html).toContain("Was soll sich an „Quote bot“ ändern?");
    expect(html).not.toContain("Was soll der neue Agent tun?");
    expect(html).not.toContain("Kundenfragen beantworten");
  });

  it("keeps the agent's own welcome and prompts in a chat of its own", () => {
    const html = startPage(undefined);
    expect(html).toContain("How can I help with the demo workflow?");
    expect(html).toContain("Check weather");
  });
});

describe("Build on an agent's page where no agent that builds is offered", () => {
  it.each([
    ["en", "No agent that builds is offered here; an admin can offer one."],
    ["de", "Hier wird kein Agent zum Bauen angeboten; ein Admin kann einen anbieten."]
  ] as const)("says so in one sentence in %s, with no chat to start", (locale, sentence) => {
    const html = renderToStaticMarkup(
      createElement(TranslationProvider, { children: null, locale }, createElement(BuildUnoffered))
    );
    expect(html).toContain(sentence);
    expect(html).not.toContain("textarea");
  });
});
