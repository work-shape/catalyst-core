import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ThreadStartBlock } from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The empty chat names the Knowledge Bases the agent answers from as quiet labels beside the
// starters: an icon and the title, the description on hover or focus, and nothing to send.

const noop = () => undefined;

function EmptyConversation({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime({
    async run() {
      return { content: [] };
    }
  });
  return createElement(AssistantRuntimeProvider, { runtime }, children);
}

type Props = Parameters<typeof ThreadStartBlock>[0];

function startBlock(props: Partial<Props>, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(
        EmptyConversation,
        null,
        createElement(ThreadStartBlock, {
          initialPrompts: [{ title: "Compare two products", prompt: "Compare" }],
          starters: [],
          onStarterChosen: noop,
          ...props
        })
      )
    )
  );
}

const knowledgeBases = [
  { name: "handbook", title: "Product handbook", description: "Every product and its options." },
  { name: "prices", title: "Price list" }
];

describe("the Knowledge Bases on the empty chat", () => {
  it("names each with the knowledge icon, its title and a name for assistive technology", () => {
    const markup = startBlock({ knowledgeBases });
    expect(markup).toContain('<ul aria-label="Knowledge"');
    expect(markup.match(/lucide-library/gu)).toHaveLength(2);
    expect(markup).toContain("Product handbook");
    expect(markup).toContain('aria-label="Knowledge: Product handbook"');
    expect(markup).toContain("Knowledge: Price list");
    expect(markup.match(/data-tone="quiet"/gu)).toHaveLength(2);
    // The labels come before the starters and are no requests themselves.
    expect(markup.indexOf("Product handbook")).toBeLessThan(markup.indexOf("Compare two products"));
  });

  it("speaks German where the person does, and writes no prefix before the labels", () => {
    const markup = startBlock({ knowledgeBases }, "de");
    expect(markup).toContain('<ul aria-label="Wissen"');
    expect(markup).toContain('aria-label="Wissen: Product handbook"');
    expect(markup).not.toContain("Kennt");
  });

  it("offers the description only where there is one", () => {
    const markup = startBlock({ knowledgeBases });
    // A label with a description takes focus to show it; one without is plain text.
    expect(markup.match(/<button type="button" aria-label="Knowledge: /gu)).toHaveLength(1);
  });

  it("folds many into one chip that says how many more there are", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      name: `kb-${String(index + 1)}`,
      title: `Knowledge Base ${String(index + 1)}`
    }));
    const markup = startBlock({ knowledgeBases: many });
    expect(markup).toContain("Knowledge Base 6");
    expect(markup).not.toContain("Knowledge Base 7");
    expect(markup).toContain("+3");
    expect(markup).toContain('aria-label="Show 3 more Knowledge Bases"');
    expect(startBlock({ knowledgeBases: many }, "de")).toContain(
      'aria-label="3 weitere Wissensbasen anzeigen"'
    );
  });

  it("shows nothing for an agent without Knowledge Bases, or in a chat about an asset", () => {
    expect(startBlock({})).not.toContain("<ul");
    expect(startBlock({ knowledgeBases: [] })).not.toContain("lucide-library");
    expect(
      startBlock({ knowledgeBases, start: { about: "asset", kind: "app", title: "Rate card" } })
    ).not.toContain("Product handbook");
  });
});
