import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { ConfigCheckPanel } from "../packages/chat-ui/src/workspace-chrome";

describe("workspace config status", () => {
  it("keeps the loading state neutral until customer config is available", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "en" },
        createElement(ConfigCheckPanel, { className: undefined, error: undefined })
      )
    );

    expect(markup).toContain("Loading configuration…");
    expect(markup).not.toContain("Vivd Catalyst");
    expect(markup).not.toContain("lucide-shield");
  });

  it("shows a localized neutral error when config loading fails without details", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(ConfigCheckPanel, { className: undefined, error: "" })
      )
    );

    expect(markup).toContain("Arbeitsbereich konnte nicht geladen werden");
    expect(markup).toContain("Bitte lade die Seite neu und versuche es noch einmal.");
  });
});
