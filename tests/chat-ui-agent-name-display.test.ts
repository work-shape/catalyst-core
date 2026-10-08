import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadWelcomeHeading } from "../packages/chat-ui/src/assistant/assistant-thread";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import {
  AgentChipFlightProvider,
  useAgentChipFlightState
} from "../packages/chat-ui/src/workspace/agent-chip-flight";
import {
  agentContextLabelFor,
  WorkspaceChrome
} from "../packages/chat-ui/src/workspace/workspace-chrome";

const noop = () => undefined;

const oneAgent = [
  {
    name: "catalyst_assistant",
    displayName: "Catalyst Assistant",
    initialPrompts: []
  }
];
const severalAgents = [
  ...oneAgent,
  {
    name: "research_assistant",
    displayName: "Research Assistant",
    initialPrompts: []
  }
];

function renderHeader({
  agents = oneAgent,
  clientName,
  locale = "en",
  showAgentName = false,
  showAgentSelector = true
}: {
  agents?: typeof oneAgent;
  clientName?: string;
  locale?: "de" | "en";
  showAgentName?: boolean;
  showAgentSelector?: boolean;
} = {}) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale },
      createElement(WorkspaceChrome, {
        agents,
        contextLabel: agentContextLabelFor({
          ui: { showAgentName, clientName },
          clientInstance: { displayName: "Vivd Catalyst" }
        }),
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

function renderStartPage(agents: typeof oneAgent, chipInHeader = false) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "en" as const },
      createElement(
        AgentChipFlightProvider,
        {
          flight: {
            chipInHeader,
            originRef: { current: null },
            destinationRef: { current: null },
            depart: noop,
            cancel: noop
          }
        },
        createElement(ThreadWelcomeHeading, {
          agent: agents[0],
          agents,
          fallbackWelcomeMessage: "How can I help?",
          onSelectAgent: noop
        })
      )
    )
  );
}

/** The markup of a single agent's plain label: icon and name, without its frame. */
function labelContent(markup: string): string {
  const content = /<div class="[^"]*" title="Catalyst Assistant">(.*?)<\/div>/u.exec(markup)?.[1];
  if (!content) throw new Error("agent label not found");
  return content;
}

/** The tone the shared chip gives the agent's name, and the classes that tone resolves to. */
function agentName(markup: string): { tone: string; classes: string[] } {
  const [, classes, tone] =
    /<span class="([^"]*)" data-agent-chip-name="([^"]*)">Catalyst Assistant<\/span>/u.exec(
      markup
    ) ?? [];
  if (classes === undefined || tone === undefined) throw new Error("agent name not found");
  return { tone, classes: classes.split(" ") };
}

describe("agent chip in the header", () => {
  it("names a single agent on a plain label", () => {
    const markup = renderHeader();

    expect(markup).toContain(">Catalyst Assistant<");
    expect(markup).toContain('title="Catalyst Assistant"');
    expect(markup).not.toContain("Select agent");
    expect(markup).not.toContain("aria-haspopup");
  });

  it("names the selected agent on the picker when there are several", () => {
    const markup = renderHeader({ agents: severalAgents });

    expect(markup).toContain('aria-label="Select agent: Catalyst Assistant"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain(">Catalyst Assistant<");
    expect(markup).not.toContain("Research Assistant");
  });

  it("labels the picker in German", () => {
    expect(renderHeader({ agents: severalAgents, locale: "de" })).toContain(
      'aria-label="Agent auswählen: Catalyst Assistant"'
    );
  });

  it("keeps only the icon on narrow screens, with the name as title and for screen readers", () => {
    for (const agents of [oneAgent, severalAgents]) {
      const markup = renderHeader({ agents });

      expect(markup).toContain('title="Catalyst Assistant"');
      expect(markup).toMatch(/max-sm:sr-only"><span [^>]*>Catalyst Assistant<\/span>/u);
    }
  });

  it.each([undefined, "Client label"])(
    "uses ui.showAgentName to control the client subtitle with clientName %s",
    (clientName) => {
      const clientLabel = clientName ?? "Vivd Catalyst";
      const shown = renderHeader({ clientName, showAgentName: true });
      const hidden = renderHeader({ clientName, showAgentName: false });

      expect(shown).toContain(`>${clientLabel}<`);
      expect(hidden).not.toContain(clientLabel);
      expect(shown).toContain(">Catalyst Assistant<");
      expect(hidden).toContain(">Catalyst Assistant<");
    }
  );

  it("prefers the configured client name over the instance display name", () => {
    const markup = renderHeader({ clientName: "Client label", showAgentName: true });

    expect(markup).toContain(">Client label<");
    expect(markup).not.toContain("Vivd Catalyst");
  });

  it("stays empty while the start page shows the agent", () => {
    for (const agents of [oneAgent, severalAgents]) {
      const markup = renderHeader({ agents, showAgentSelector: false });

      expect(markup).not.toContain("Catalyst Assistant");
      expect(markup).not.toContain("aria-haspopup");
    }
  });
});

describe("agent chip on the start page", () => {
  it("names a single agent above the welcome message without anything to open", () => {
    const markup = renderStartPage(oneAgent);

    expect(markup).not.toContain("<button");
    expect(markup).toContain(">Catalyst Assistant<");
    expect(markup.indexOf("Catalyst Assistant")).toBeLessThan(markup.indexOf("How can I help?"));
    expect(markup).not.toContain("invisible");
  });

  it("gives a single agent's label the same icon and name as the picker", () => {
    const label = labelContent(renderStartPage(oneAgent));
    const picker = renderStartPage(severalAgents);

    expect(label).toContain("<svg");
    expect(label).toContain(">Catalyst Assistant<");
    expect(picker).toContain(`${label}<svg`);
    expect(labelContent(renderHeader())).toContain(">Catalyst Assistant<");
    expect(renderHeader({ agents: severalAgents })).toContain(
      `${labelContent(renderHeader())}<svg`
    );
  });

  it("leads with a strong name, which the header quietens at the same size", () => {
    for (const agents of [oneAgent, severalAgents]) {
      const start = agentName(renderStartPage(agents));
      const header = agentName(renderHeader({ agents }));

      expect(start.tone).toBe("strong");
      expect(start.classes).toContain("font-semibold");
      expect(start.classes).not.toContain("text-muted-foreground");
      expect(header.tone).toBe("subtle");
      expect(header.classes).toEqual(
        expect.arrayContaining(["font-medium", "text-muted-foreground"])
      );
      expect(header.classes).not.toContain("font-semibold");
      expect(start.classes).toContain("text-sm");
      expect(header.classes).toContain("text-sm");
    }
  });

  it("always shows the name, on narrow screens too", () => {
    for (const agents of [oneAgent, severalAgents]) {
      expect(renderStartPage(agents)).not.toContain("max-sm:sr-only");
    }
  });

  it("only keeps its place once the header shows the agent", () => {
    for (const agents of [oneAgent, severalAgents]) {
      const markup = renderStartPage(agents, true);

      expect(markup).toContain("invisible");
      expect(markup).toContain("How can I help?");
    }
  });
});

describe("agent chip placement", () => {
  function renderPlacement(onStartPage: boolean) {
    return renderToStaticMarkup(
      createElement(() => (useAgentChipFlightState(onStartPage).chipInHeader ? "header" : "start"))
    );
  }

  it("is the start page's while no conversation is selected, otherwise the header's", () => {
    expect(renderPlacement(true)).toBe("start");
    expect(renderPlacement(false)).toBe("header");
  });
});
