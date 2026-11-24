import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ThreadStartBlock } from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The empty chat names the Knowledge Bases the agent answers from beside the starters, and none
// in a chat about an asset.

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

function startBlock(props: Partial<Props>): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" },
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
  it("names them, and nothing for an agent without Knowledge Bases or in a chat about an asset", () => {
    expect(startBlock({ knowledgeBases })).toContain("Product handbook");
    expect(startBlock({})).not.toContain("<ul");
    expect(startBlock({ knowledgeBases: [] })).not.toContain("<ul");
    expect(
      startBlock({ knowledgeBases, start: { about: "asset", kind: "app", title: "Rate card" } })
    ).not.toContain("Product handbook");
  });
});
