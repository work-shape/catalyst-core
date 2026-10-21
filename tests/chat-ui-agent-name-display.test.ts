import { createElement } from "react";
import { renderToStaticMarkup } from "./chat-ui-render-harness";
import { describe, expect, it } from "vitest";
import {
  ThreadWelcomeHeading,
  agentChipDisplayFor,
  agentPickerOptions,
  WorkspaceChrome
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
  locale = "en",
  showAgentName = true,
  showAgentSelector = true,
  surfaceBesideWidth = 0,
  conversation = true
}: {
  agents?: typeof severalAgents;
  locale?: "de" | "en";
  showAgentName?: boolean;
  showAgentSelector?: boolean;
  surfaceBesideWidth?: number;
  conversation?: boolean;
} = {}) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
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

/** The markup of a single agent's plain label: icon and name, without its frame. */
function labelContent(markup: string): string {
  const content = /<div class="[^"]*" title="Catalyst Assistant">(.*?)<\/div>/u.exec(markup)?.[1];
  if (!content) throw new Error("agent label not found");
  return content;
}

/** The chip as the button that opens the agent list, without the id of the list it opens. */
function chipButton(markup: string): string | undefined {
  return /<button[^>]*aria-haspopup[^>]*>.*?<\/button>/u
    .exec(markup)?.[0]
    .replace(/ aria-controls="[^"]*"/u, "");
}

describe("agent chip in the header", () => {
  // ACCEPT-2d: the header of a conversation showed the icon alone, so nobody read which agent
  // answers there.
  it("names the agent beside its icon where the instance shows the name", () => {
    for (const agents of [oneAgent, severalAgents]) {
      const markup = renderHeader({ agents });

      expect(markup).toContain(">Catalyst Assistant<");
      expect(markup).toContain('title="Catalyst Assistant"');
      expect(markup).toContain("<svg");
      expect(markup).not.toContain("Research Assistant");
    }
    // Several agents keep the chip the button that opens the list.
    expect(renderHeader({ agents: severalAgents })).toContain(
      'aria-label="Select agent: Catalyst Assistant"'
    );
  });

  it("is the icon alone on a button that announces the agent list where the instance hides the name", () => {
    for (const agents of [oneAgent, severalAgents]) {
      const markup = renderHeader({ agents, showAgentName: false });

      expect(markup).toContain('aria-label="Select agent: Catalyst Assistant"');
      expect(markup).toContain('title="Catalyst Assistant"');
      expect(markup).toContain('aria-haspopup="dialog"');
      expect(markup).toContain("<svg");
      expect(markup).not.toContain(">Catalyst Assistant<");
      expect(markup).not.toContain("Research Assistant");
    }
  });

  it("is the same chip as on the start page, so only its place changes", () => {
    for (const showAgentName of [true, false]) {
      for (const agents of [oneAgent, severalAgents]) {
        const header = renderHeader({ agents, showAgentName });
        const start = renderStartPage(agents, showAgentName);
        const chip = chipButton(header) ?? labelContent(header);

        expect(chipButton(start) ?? labelContent(start)).toBe(chip);
      }
    }
  });

  it("labels the chip in German", () => {
    expect(renderHeader({ agents: severalAgents, locale: "de" })).toContain(
      'aria-label="Agent auswählen: Catalyst Assistant"'
    );
  });

  // Beside a surface the band covers scrolled text and continues the surface's line.
  it("stands on an opaque band beside a surface, with a line at the panel seam", () => {
    const header = (markup: string) => /<header[^>]*>/u.exec(markup)?.[0] ?? "";
    const beside = renderHeader({ surfaceBesideWidth: 520 });

    expect(header(beside)).toContain("data-beside-surface");
    expect(header(beside)).toContain("h-(--layout-header)");
    expect(header(beside)).toContain("border-b");
    expect(header(beside)).toContain("bg-background");
    expect(header(beside)).toContain("after:bg-gradient-to-b");
    expect(header(beside)).toContain("after:top-full");
    expect(header(beside)).toContain("after:h-4");

    expect(header(beside)).not.toMatch(/\bmd:bg-transparent\b/u);
    expect(beside).not.toContain("data-header-fade");
  });

  // Fails with the band of #210 at every width: from 768 px up a conversation no longer
  // scrolled to the window's top, and the band cut it off under the agent picker.
  it("floats over a conversation alone from 768 px up, and keeps the band at phone width", () => {
    const header = (markup: string) => /<header[^>]*>/u.exec(markup)?.[0] ?? "";
    const alone = renderHeader();

    expect(header(alone)).not.toContain("data-beside-surface");
    expect(header(alone)).not.toContain("border-b");
    // At phone width the band and its 1rem fade stand.
    expect(header(alone)).toContain("bg-background");
    expect(header(alone)).toContain("after:bg-gradient-to-b");
    // From 768 px up both go, and a light fade keeps the controls legible.
    expect(header(alone)).toMatch(/\bmd:bg-transparent\b/u);
    expect(header(alone)).toMatch(/\bmd:after:hidden\b/u);
    const fade = /<div[^>]*data-header-fade[^>]*>/u.exec(alone)?.[0] ?? "";
    expect(fade).toContain("from-background/25");
    expect(fade).toMatch(/\bmax-md:hidden\b/u);

    // Outside a conversation the band rules of 06d6c7922 stand.
    const elsewhere = renderHeader({ conversation: false, showAgentSelector: false });
    expect(header(elsewhere)).not.toMatch(/\bmd:bg-transparent\b/u);
    expect(elsewhere).not.toContain("data-header-fade");
  });

  // Fails with the band on every page: at 390 px it covered the pinned head of a Studio page,
  // an App and a Workflow, their name and their actions.
  it("gives way to a pinned detail head outside a conversation, and stands on a conversation", () => {
    const header = (markup: string) => /<header[^>]*>/u.exec(markup)?.[0] ?? "";
    const givesWay =
      "group-has-[[data-page-head][data-variant=detail]]/workspace-content:bg-transparent";
    const elsewhere = header(renderHeader({ conversation: false, showAgentSelector: false }));

    // In a narrow window a list scrolls under the band as a conversation does.
    expect(elsewhere).toContain("bg-background");
    expect(elsewhere).toContain(givesWay);
    expect(elsewhere).toContain(
      "group-has-[[data-page-head][data-variant=detail]]/workspace-content:after:hidden"
    );
    expect(header(renderHeader())).not.toContain(givesWay);
  });

  // Fails with the band on every page at every width: from 768 px up the band and its fade
  // covered a page's title line, 56 px down, and the sub-rail's area name; at 390 px the band
  // covered that area name beside the sidebar button.
  it("leaves a page outside a conversation from 768 px up, and gives way to a sub-rail's area name", () => {
    const header = (markup: string) => /<header[^>]*>/u.exec(markup)?.[0] ?? "";
    const elsewhere = header(renderHeader({ conversation: false, showAgentSelector: false }));
    const conversation = header(renderHeader());

    expect(elsewhere).toMatch(/\bmd:hidden\b/u);
    expect(conversation).not.toMatch(/\bmd:hidden\b/u);
    expect(elsewhere).toContain(
      "group-has-[[data-subrail-title]]/workspace-content:bg-transparent"
    );
    expect(elsewhere).toContain("group-has-[[data-subrail-title]]/workspace-content:after:hidden");
    expect(conversation).not.toContain("data-subrail-title");
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
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain(">Catalyst Assistant<");
    expect(markup).not.toContain("Research Assistant");
  });

  it("gives a single agent's label the same icon and name as the picker", () => {
    const label = labelContent(renderStartPage(oneAgent));

    // The agent's mark of the Agents page and Studio, not a mark of the chip's own.
    expect(label).toMatch(/^<span aria-hidden="true" data-kind="agent"[^>]*><svg[^>]*lucide-bot/u);
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
      expect(markup).toContain('aria-haspopup="dialog"');
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
  function options(showAgentDescriptions: boolean | undefined) {
    return agentPickerOptions(severalAgents, display({ showAgentDescriptions }).showDescriptions);
  }

  it("names the agents without their descriptions when the instance hides them", () => {
    expect(options(false)).toEqual([
      { value: "catalyst_assistant", label: "Catalyst Assistant" },
      { value: "research_assistant", label: "Research Assistant" }
    ]);
  });

  it("puts each description under its agent's name unless the instance hides them", () => {
    for (const listed of [options(undefined), options(true)]) {
      expect(listed).toEqual([
        {
          value: "catalyst_assistant",
          label: "Catalyst Assistant",
          description: "Answers questions about Catalyst."
        },
        { value: "research_assistant", label: "Research Assistant" }
      ]);
    }
  });
});

describe("agent settings", () => {
  it("show the name and the descriptions before the instance's settings are known", () => {
    expect(agentChipDisplayFor(undefined)).toEqual({ showName: true, showDescriptions: true });
  });

  it("follow ui.showAgentName and ui.showAgentDescriptions independently", () => {
    expect(display({ showAgentName: true })).toEqual({ showName: true, showDescriptions: false });
    expect(display({ showAgentDescriptions: true })).toEqual({
      showName: false,
      showDescriptions: true
    });
  });
});
