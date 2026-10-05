import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import { shouldExpandComposer } from "../packages/chat-ui/src/assistant/assistant-composer";
import { StartPageAgentCards } from "../packages/chat-ui/src/assistant/assistant-thread";
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

function renderAgentCards(availableAgents: typeof agents) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "en" as const },
      createElement(StartPageAgentCards, {
        agents: availableAgents,
        selectedAgentName: "research_assistant",
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

describe("start page agent cards", () => {
  it("offers one card per available agent and marks the selected one", () => {
    const markup = renderAgentCards(agents);

    expect(markup.match(/<button/gu)).toHaveLength(2);
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Select agent"');
    expect(markup).toContain("Application Assistant");
    expect(markup).toContain("Help with application review.");
    expect(markup).toMatch(/aria-pressed="false"[^>]*>.*Application Assistant/u);
    expect(markup).toMatch(/aria-pressed="true"[^>]*>.*Research Assistant/u);
  });

  it("shows no cards when there is nothing to choose", () => {
    expect(renderAgentCards(agents.slice(0, 1))).toBe("");
    expect(renderAgentCards([])).toBe("");
  });
});
