import { createElement } from "react";
import { renderToStaticMarkup } from "./chat-ui-render-harness";
import { describe, expect, it } from "vitest";
import {
  ThreadWelcomeHeading,
  agentChangeLines,
  agentChipDisplayFor,
  agentPickerOptions,
  WorkspaceChrome,
  withRunUnderway
} from "./support/chat-ui";
import { TranslationProvider } from "./chat-ui-render-harness";

const noop = () => undefined;

const oneAgent = [
  {
    name: "catalyst_assistant",
    displayName: "Catalyst Assistant",
    description: "Answers questions about Catalyst.",
    selectableModels: [],
    initialPrompts: []
  }
] satisfies [Parameters<typeof WorkspaceChrome>[0]["agents"][number]];
const severalAgents = [
  ...oneAgent,
  {
    name: "research_assistant",
    displayName: "Research Assistant",
    selectableModels: [],
    initialPrompts: []
  }
];

/** The instance's two agent settings, as the chip receives them. */
function display(ui: { showAgentName?: boolean; showAgentDescriptions?: boolean } = {}) {
  return agentChipDisplayFor({ showAgentName: false, showAgentDescriptions: false, ...ui });
}

function renderHeader({
  agents = oneAgent,
  showAgentName = true,
  showAgentSelector = true,
  surfaceBesideWidth = 0,
  conversation = true
}: {
  agents?: typeof severalAgents;
  showAgentName?: boolean;
  showAgentSelector?: boolean;
  surfaceBesideWidth?: number;
  conversation?: boolean;
} = {}) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" as const },
      createElement(WorkspaceChrome, {
        agentDisplay: display({ showAgentName }),
        agents,
        conversation,
        surfaceBesideWidth,
        covered: false,
        selectedAgentName: "catalyst_assistant",
        showAgentSelector,
        onSelectAgent: noop,
        onOpenSidebar: noop
      })
    )
  );
}

function renderStartPage(agents: typeof severalAgents, showAgentName = true, showAgent = true) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" as const },
      createElement(ThreadWelcomeHeading, {
        agent: agents[0],
        agentDisplay: display({ showAgentName }),
        agents,
        showAgent,
        fallbackWelcomeMessage: "How can I help?",
        onSelectAgent: noop
      })
    )
  );
}

/** The chip as the button that opens the agent list, without the id of the list it opens. */
function chipButton(markup: string): string | undefined {
  return /<button[^>]*aria-haspopup[^>]*>.*?<\/button>/u
    .exec(markup)?.[0]
    .replace(/ aria-controls="[^"]*"/u, "");
}

describe("agent chip", () => {
  // ACCEPT-2d: the header of a conversation showed the icon alone, so nobody read which agent
  // answers there.
  it("names the agent where the instance shows the name, and is the icon alone where it hides it", () => {
    for (const agents of [oneAgent, severalAgents]) {
      expect(renderHeader({ agents })).toContain(">Catalyst Assistant<");
      const hidden = renderHeader({ agents, showAgentName: false });
      expect(hidden).toContain('aria-label="Select agent: Catalyst Assistant"');
      expect(hidden).not.toContain(">Catalyst Assistant<");
      expect(hidden).not.toContain("Research Assistant");
    }
  });

  it("is the same chip in the header as on the start page, and in only one of them", () => {
    for (const agents of [oneAgent, severalAgents]) {
      expect(chipButton(renderHeader({ agents, showAgentName: false }))).toBe(
        chipButton(renderStartPage(agents, false))
      );
      expect(renderHeader({ agents, showAgentSelector: false })).not.toContain(
        "Catalyst Assistant"
      );
      expect(renderStartPage(agents, true, false)).not.toContain("Catalyst Assistant");
    }
    // A single agent is named on the start page without anything to open; several open a list.
    expect(renderStartPage(oneAgent)).not.toContain("<button");
    expect(renderStartPage(severalAgents)).toContain('aria-haspopup="dialog"');
  });
});

describe("the header band (layout fixes 1fd4d1637, 511439423, 74dfab7a1, 836b811e1)", () => {
  const header = (markup: string) => /<header[^>]*>/u.exec(markup)?.[0] ?? "";

  it("is opaque beside a surface, floats over a conversation alone from 768 px up, and leaves other pages", () => {
    const beside = header(renderHeader({ surfaceBesideWidth: 520 }));
    expect(beside).toContain("bg-background");
    expect(beside).not.toMatch(/\bmd:bg-transparent\b/u);

    const alone = renderHeader();
    expect(header(alone)).toMatch(/\bmd:bg-transparent\b/u);
    // Scrolled text never shows through the controls themselves.
    const controls = /<div[^>]*data-header-controls[^>]*>/u.exec(alone)?.[0] ?? "";
    expect(controls).toMatch(/\bmd:bg-background\b/u);

    // Outside a conversation it gives way to a pinned detail head and a sub-rail's area name.
    const elsewhere = header(renderHeader({ conversation: false, showAgentSelector: false }));
    expect(elsewhere).toMatch(/\bmd:hidden\b/u);
    expect(elsewhere).toContain(
      "group-has-[[data-page-head][data-variant=detail]]/workspace-content:bg-transparent"
    );
    expect(elsewhere).toContain(
      "group-has-[[data-subrail-title]]/workspace-content:bg-transparent"
    );
    expect(header(alone)).not.toMatch(/\bmd:hidden\b/u);
  });
});

describe("agent list and settings", () => {
  it("puts descriptions under the names unless the instance hides them, and the builders last", () => {
    const options = (showAgentDescriptions: boolean | undefined) =>
      agentPickerOptions(
        severalAgents,
        display({ showAgentDescriptions }).showDescriptions,
        "For building"
      );
    expect(options(false)).toEqual([
      { value: "catalyst_assistant", label: "Catalyst Assistant" },
      { value: "research_assistant", label: "Research Assistant" }
    ]);
    expect(options(true)[0]).toEqual({
      value: "catalyst_assistant",
      label: "Catalyst Assistant",
      description: "Answers questions about Catalyst."
    });
    const [first, research] = severalAgents;
    if (!first || !research) throw new Error("Two agents are listed");
    const withBuilder = [
      { ...first, name: "workshaper", displayName: "Workshaper", buildsAssets: true },
      research
    ];
    expect(agentPickerOptions(withBuilder, false, "Zum Bauen")).toEqual([
      { value: "research_assistant", label: "Research Assistant" },
      { heading: "Zum Bauen", options: [{ value: "workshaper", label: "Workshaper" }] }
    ]);
  });

  it("show the name and the descriptions until the instance's settings are known, then follow each", () => {
    expect(agentChipDisplayFor(undefined)).toEqual({ showName: true, showDescriptions: true });
    expect(display({ showAgentName: true })).toEqual({ showName: true, showDescriptions: false });
    expect(display({ showAgentDescriptions: true })).toEqual({
      showName: false,
      showDescriptions: true
    });
  });
});

// T30, wish 2: where another agent answers from a message on, the history says so above that
// message, read from the runs' agents so every reader sees it, after a reload too.

const message = (id: string) => ({ id });
const run = (inputMessageId: string, agentName: string) => ({ inputMessageId, agentName });

describe("agent change lines", () => {
  it("marks the message from which another agent answers, and the change back", () => {
    const messages = ["m1", "a1", "m2", "a2", "m3", "a3", "m4", "a4"].map(message);
    const lines = agentChangeLines(messages, [
      run("m1", "general"),
      run("m2", "general"),
      run("m3", "personal"),
      run("m4", "general")
    ]);
    expect([...lines]).toEqual([
      ["m3", "personal"],
      ["m4", "general"]
    ]);
    // The first run gets no line.
    expect([...agentChangeLines([message("m1"), message("a1")], [run("m1", "general")])]).toEqual(
      []
    );
  });

  it("skips messages that started no run and counts a message's last run", () => {
    const messages = ["m1", "a1", "s1", "m2", "a2"].map(message);
    // `s1` was steered into the first run; `m2` was answered again by another agent.
    const lines = agentChangeLines(messages, [
      run("m1", "general"),
      run("m2", "general"),
      run("m2", "personal")
    ]);
    expect([...lines]).toEqual([["m2", "personal"]]);
  });

  it("adds the run underway until the thread names it", () => {
    const listed = [run("m1", "general")];
    expect(withRunUnderway(listed, undefined, undefined)).toBe(listed);
    expect(withRunUnderway(listed, "m1", "general")).toBe(listed);
    expect(withRunUnderway(listed, "m2", "personal")).toEqual([
      run("m1", "general"),
      run("m2", "personal")
    ]);
  });
});
