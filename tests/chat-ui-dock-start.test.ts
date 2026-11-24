import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { SafeConfig } from "@work-shape/catalyst-api-client";
import {
  agentChipDisplayFor,
  dockConversationToReuse,
  conversationStart,
  dockBuildKind,
  dockKindOfRoute,
  ThreadStartBlock,
  ThreadWelcomeHeading,
  BuildUnoffered,
  TRY_DOCK_KIND,
  type ConversationStart
} from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// ACCEPT-1c C6 (#260): every dock that builds or changes an asset greeted with the configured
// agent's own welcome and offered its prompts, whatever was built. The start page of such a
// conversation now speaks of the asset it is about, or of the new one of the kind beside the
// dock, and never of the agent's.

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

function startPage(start: ConversationStart | undefined): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" },
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

const DEMO_WORDS = ["demo workflow", "Check weather", "Oslo", "Review a workflow", "Demo subtitle"];

describe("the start page of a dock that builds", () => {
  it("knows the kind a new asset of which the list beside the dock builds", () => {
    const workspace = { collaborationWorkspaceId: "ws" };
    expect(dockKindOfRoute({ kind: "workflows", ...workspace })).toBe("workflow");
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

  it("greets no new asset where the dock's agent builds none", () => {
    const apps = { kind: "apps" as const, collaborationWorkspaceId: "ws" };
    expect(dockBuildKind(apps, true)).toBe("app");
    expect(dockBuildKind({ kind: "workflows", collaborationWorkspaceId: "ws" }, false)).toBe(
      undefined
    );
    expect(conversationStart(undefined, dockBuildKind(apps, false))).toBeUndefined();
  });

  // An existing agent's page greeted an empty dock with "What should the new agent do?": the
  // page of an asset was read as its kind's list.
  it("never greets a new asset beside the page of an existing one", () => {
    for (const route of [
      { kind: "build-asset", assetKind: "agents", name: "quote_bot" },
      { kind: "app-edit", collaborationWorkspaceId: "ws", app: "rates" },
      { kind: "workflow-runs", collaborationWorkspaceId: "ws", workflow: "summary" }
    ] as const) {
      expect(dockKindOfRoute(route)).toBeUndefined();
    }
  });

  it("speaks of the asset or the new one, never with the agent's own welcome or prompts", () => {
    const starts: ConversationStart[] = [
      { about: "new", kind: "workflow" },
      { about: "asset", kind: "app", title: "Urlaubsanträge" },
      { about: "asset", kind: "knowledge_base", title: "Leads" }
    ];
    for (const start of starts) {
      const html = startPage(start);
      for (const word of DEMO_WORDS) expect(html).not.toContain(word);
    }
    expect(startPage({ about: "asset", kind: "app", title: "Urlaubsanträge" })).toContain(
      "Urlaubsanträge"
    );
    // Try invites its own first message, with no Build greeting or prompts.
    const tryPage = startPage(conversationStart(undefined, TRY_DOCK_KIND));
    expect(tryPage).toContain("Send a message to try the agent.");
    for (const word of DEMO_WORDS) expect(tryPage).not.toContain(word);
    // A chat of its own keeps the agent's welcome and prompts.
    const own = startPage(undefined);
    expect(own).toContain("How can I help with the demo workflow?");
    expect(own).toContain("Check weather");
  });

  it("offers no chat to start where no agent that builds is offered", () => {
    const html = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(BuildUnoffered)
      )
    );
    expect(html).not.toContain("textarea");
  });
});

// ACCEPT-1c C12: pressing "Edit with the agent" again made a second conversation. The page
// head's "Chat" opens the dock's conversation about the same asset again.
describe("pressing Chat on an asset's page again", () => {
  const subject = { kind: "app", name: "orders" };
  const base = {
    dockConversationId: "conv_1",
    dock: { subject, collaborationWorkspaceId: "cw_1" },
    subject,
    workspaceId: "cw_1",
    prompt: undefined,
    draftText: ""
  };

  it("opens the dock's conversation about the same asset again", () => {
    expect(dockConversationToReuse(base)).toBe("conv_1");
    expect(dockConversationToReuse({ ...base, draftText: "Make the" })).toBe("conv_1");
    expect(dockConversationToReuse({ ...base, prompt: "Fix it" })).toBe("conv_1");
  });

  it("makes a new conversation for another workspace, asset or the person's own words", () => {
    // An App "orders" of another workspace is another App.
    expect(
      dockConversationToReuse({ ...base, dock: { subject, collaborationWorkspaceId: "cw_other" } })
    ).toBeUndefined();
    expect(dockConversationToReuse({ ...base, dockConversationId: undefined })).toBeUndefined();
    expect(
      dockConversationToReuse({
        ...base,
        dock: { ...base.dock, subject: { kind: "workflow", name: "orders" } }
      })
    ).toBeUndefined();
    // A prompt never replaces what the person typed.
    expect(
      dockConversationToReuse({ ...base, prompt: "Fix it", draftText: "My own words" })
    ).toBeUndefined();
  });
});
