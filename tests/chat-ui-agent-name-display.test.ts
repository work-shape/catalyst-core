import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadWelcomeHeading } from "../packages/chat-ui/src/assistant/assistant-thread";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { agentChipDisplayFor, AgentList } from "../packages/chat-ui/src/workspace/agent-selector";
import { WorkspaceChrome } from "../packages/chat-ui/src/workspace/workspace-chrome";

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
  locale = "en",
  showAgentName = true,
  showAgentSelector = true
}: {
  agents?: typeof severalAgents;
  locale?: "de" | "en";
  showAgentName?: boolean;
  showAgentSelector?: boolean;
} = {}) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(WorkspaceChrome, {
        agentDisplay: display({ showAgentName }),
        agents,
        displayPanelOpen: false,
        displayPanelWidth: 0,
        environment: "production" as const,
        sidebarOpen: false,
        selectedAgentName: "catalyst_assistant",
        showAgentSelector,
        themeMode: "light" as const,
        onSelectAgent: noop,
        onToggleSidebar: noop,
        onToggleTheme: noop
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

/** The markup of a single agent's plain label: icon and name, without its frame. */
function labelContent(markup: string): string {
  const content = /<div class="[^"]*" title="Catalyst Assistant">(.*?)<\/div>/u.exec(markup)?.[1];
  if (!content) throw new Error("agent label not found");
  return content;
}

/** The chip as the button that opens the agent list. */
function chipButton(markup: string): string | undefined {
  return /<button[^>]*aria-haspopup[^>]*>.*?<\/button>/u.exec(markup)?.[0];
}

describe("agent chip in the header", () => {
  const settings = [
    ["shows", true],
    ["hides", false]
  ] as const;

  it.each(settings)(
    "is the icon alone on a button that announces the agent list when the instance %s the name",
    (_, showAgentName) => {
      for (const agents of [oneAgent, severalAgents]) {
        const markup = renderHeader({ agents, showAgentName });

        expect(markup).toContain('aria-label="Select agent: Catalyst Assistant"');
        expect(markup).toContain('title="Catalyst Assistant"');
        expect(markup).toContain('aria-haspopup="listbox"');
        expect(markup).toContain("<svg");
        expect(markup).not.toContain(">Catalyst Assistant<");
        expect(markup).not.toContain("Research Assistant");
      }
    }
  );

  it("is the same chip whatever the instance shows on the start page", () => {
    for (const agents of [oneAgent, severalAgents]) {
      const named = chipButton(renderHeader({ agents, showAgentName: true }));

      expect(named).toBeDefined();
      expect(chipButton(renderHeader({ agents, showAgentName: false }))).toBe(named);
    }
  });

  it("labels the chip in German", () => {
    expect(renderHeader({ agents: severalAgents, locale: "de" })).toContain(
      'aria-label="Agent auswählen: Catalyst Assistant"'
    );
  });

  it("stays empty while the start page shows the agent", () => {
    for (const showAgentName of [true, false]) {
      for (const agents of [oneAgent, severalAgents]) {
        const markup = renderHeader({ agents, showAgentName, showAgentSelector: false });

        expect(markup).not.toContain("Catalyst Assistant");
        expect(markup).not.toContain("aria-haspopup");
      }
    }
  });
});

describe("named agent chip on the start page", () => {
  it("names a single agent above the welcome message without anything to open", () => {
    const markup = renderStartPage(oneAgent);

    expect(markup).not.toContain("<button");
    expect(markup).toContain(">Catalyst Assistant<");
    expect(markup).toContain('title="Catalyst Assistant"');
    expect(markup.indexOf("Catalyst Assistant")).toBeLessThan(markup.indexOf("How can I help?"));
    expect(markup).not.toContain("invisible");
  });

  it("names the selected agent on the picker when there are several", () => {
    const markup = renderStartPage(severalAgents);

    expect(markup).toContain('aria-label="Select agent: Catalyst Assistant"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain(">Catalyst Assistant<");
    expect(markup).not.toContain("Research Assistant");
  });

  it("gives a single agent's label the same icon and name as the picker", () => {
    const label = labelContent(renderStartPage(oneAgent));

    expect(label).toContain("<svg");
    expect(label).toContain(">Catalyst Assistant<");
    expect(renderStartPage(severalAgents)).toContain(`${label}<svg`);
  });

  it("is never a hidden placeholder, and leaves none in the header", () => {
    for (const agents of [oneAgent, severalAgents]) {
      expect(renderStartPage(agents)).not.toContain("invisible");
      expect(renderHeader({ agents, showAgentSelector: false })).not.toContain("invisible");
    }
  });

  it("is gone without a trace where the header shows the agent", () => {
    for (const agents of [oneAgent, severalAgents]) {
      const markup = renderStartPage(agents, true, false);

      expect(markup).not.toContain("Catalyst Assistant");
      expect(markup).not.toContain("<svg");
      // Nothing stands above the welcome message, not even an empty slot.
      expect(markup).toMatch(/^<div class="[^"]*"><div class="[^"]*"><h2[^>]*>How can I help\?</u);
    }
  });
});

describe("agent chip on the start page without the name", () => {
  it("is the icon alone on a button that announces the agent list", () => {
    for (const agents of [oneAgent, severalAgents]) {
      const markup = renderStartPage(agents, false);

      expect(markup).toContain('aria-label="Select agent: Catalyst Assistant"');
      expect(markup).toContain('title="Catalyst Assistant"');
      expect(markup).toContain('aria-haspopup="listbox"');
      expect(markup).toContain("<svg");
      expect(markup).not.toContain(">Catalyst Assistant<");
    }
  });

  it("is the same chip as in the header, so only its place changes", () => {
    for (const agents of [oneAgent, severalAgents]) {
      const start = chipButton(renderStartPage(agents, false));

      expect(start).toBeDefined();
      expect(chipButton(renderHeader({ agents, showAgentName: false }))).toBe(start);
    }
  });
});

describe("agent list", () => {
  function renderList(showAgentDescriptions: boolean | undefined) {
    const selectedAgent = severalAgents[0];
    if (!selectedAgent) {
      throw new Error("Expected an agent fixture");
    }
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" as const },
        createElement(AgentList, {
          agents: severalAgents,
          selectedAgent,
          showDescriptions: display({ showAgentDescriptions }).showDescriptions,
          onSelectAgent: noop
        })
      )
    );
  }

  it("names the agents without their descriptions unless the instance shows them", () => {
    for (const markup of [renderList(undefined), renderList(false)]) {
      expect(markup).toContain(">Catalyst Assistant<");
      expect(markup).toContain(">Research Assistant<");
      expect(markup).not.toContain("Answers questions about Catalyst.");
    }
  });

  it("puts each description under its agent's name when the instance shows them", () => {
    const markup = renderList(true);

    expect(markup).toContain(
      '>Catalyst Assistant</span><span class="text-xs text-muted-foreground [overflow-wrap:anywhere]">Answers questions about Catalyst.<'
    );
    expect(markup).toMatch(/>Research Assistant<\/span><\/span><\/button>/u);
  });
});

describe("agent settings", () => {
  it("show the name without descriptions before the instance's settings are known", () => {
    expect(agentChipDisplayFor(undefined)).toEqual({ showName: true, showDescriptions: false });
  });

  it("follow ui.showAgentName and ui.showAgentDescriptions independently", () => {
    expect(display({ showAgentName: true })).toEqual({ showName: true, showDescriptions: false });
    expect(display({ showAgentDescriptions: true })).toEqual({
      showName: false,
      showDescriptions: true
    });
  });
});
