import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import { shouldExpandComposer } from "../packages/chat-ui/src/assistant/assistant-composer";
import { ThreadWelcomeHeading } from "../packages/chat-ui/src/assistant/assistant-thread";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";

const agents = [
  {
    name: "application_assistant",
    displayName: "Application Assistant",
    description: "Help with application review.",
    initialPrompts: []
  },
  {
    name: "research_assistant",
    displayName: "Research Assistant",
    initialPrompts: []
  }
];

function renderWelcomeHeading(availableAgents: typeof agents) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "en" as const },
      createElement(ThreadWelcomeHeading, {
        agent: availableAgents.at(-1),
        agents: availableAgents,
        fallbackWelcomeMessage: "How can I help?",
        onSelectAgent: () => undefined
      })
    )
  );
}

describe("assistant composer layout", () => {
  it("moves controls below the input for multiline drafts", () => {
    expect(shouldExpandComposer("First line")).toBe(false);
    expect(shouldExpandComposer("First line\nSecond line")).toBe(true);
    expect(shouldExpandComposer("A long line that wraps", true)).toBe(true);
  });

  it("returns to the compact row after the line break is removed", () => {
    expect(shouldExpandComposer("First line\n")).toBe(true);
    expect(shouldExpandComposer("First line")).toBe(false);
  });
});

describe("start page agent picker", () => {
  it("names the selected agent on a picker above the welcome message", () => {
    const markup = renderWelcomeHeading(agents);

    expect(markup.match(/<button/gu)).toHaveLength(1);
    expect(markup).toContain('aria-label="Select agent"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain(">Research Assistant<");
    expect(markup).not.toContain("Application Assistant");
    expect(markup.indexOf("Research Assistant")).toBeLessThan(markup.indexOf("How can I help?"));
  });

  it("shows no picker when there is nothing to choose", () => {
    for (const available of [agents.slice(0, 1), []]) {
      const markup = renderWelcomeHeading(available);

      expect(markup).not.toContain("<button");
      expect(markup).toContain("How can I help?");
    }
  });
});
