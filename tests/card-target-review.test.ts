import { createElement } from "react";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { AgentsPage } from "@vivd-catalyst/chat-ui/agents";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Verifier's test for CARD-1 (PR 53, round 2). A card's target is named by `aria-label`, which
// replaces the text it shows. Whoever speaks to the page or reads its buttons says the text they
// see, so the name holds that text whole (WCAG 2.5.3, Label in Name). Fails at c013a285: the
// German Agent card shows "Chat starten" and is named "Chat mit Steuer-Assistent starten".

type Agent = SafeConfig["agents"][number];

const tax: Agent = {
  name: "tax.vat-helper",
  displayName: "Steuer-Assistent",
  selectableModels: [],
  initialPrompts: []
};
const noop = () => undefined;

describe("the target of an Agent card", () => {
  it.each(["en", "de"] as const)("holds the text it shows in its name (%s)", (locale) => {
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale,
        children: createElement(AgentsPage, {
          agents: [tax],
          defaultAgentName: "tax.vat-helper",
          status: "ready",
          onRetry: noop,
          onStartChat: noop
        })
      })
    );
    const target = /<button[^>]*data-card-target=""[^>]*>([^<]+)<\/button>/u.exec(markup);
    const name = /aria-label="([^"]+)"/u.exec(target?.[0] ?? "")?.[1];
    const shown = target?.[1];
    expect(shown).toBeTruthy();
    expect(name?.toLowerCase()).toContain(shown?.toLowerCase());
  });
});
