import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup as renderInUiRoot } from "./chat-ui-render-harness";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import {
  ConfigCheckPanel,
  OutdatedInterfaceBanner,
  SessionCheckPanel
} from "../packages/chat-ui/src/workspace/workspace-chrome";

describe("workspace config status", () => {
  it("keeps the loading state neutral until customer config is available", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
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
        { children: null, locale: "de" },
        createElement(ConfigCheckPanel, { className: undefined, error: "" })
      )
    );

    expect(markup).toContain("Arbeitsbereich konnte nicht geladen werden");
    expect(markup).toContain("Bitte lade die Seite neu und versuche es noch einmal.");
  });
});

describe("workspace session status", () => {
  it("shows a neutral localized failure with one manual retry", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(SessionCheckPanel, {
          className: undefined,
          unavailable: true,
          retrying: false,
          onRetry: () => undefined
        })
      )
    );

    expect(markup).toContain("Dienst nicht erreichbar");
    expect(markup).toContain("Erneut versuchen");
    expect(markup).not.toContain("beschäftigt");
    expect(markup.match(/<button/gu)).toHaveLength(1);
  });

  it("does not offer retry while the initial check is still running", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(SessionCheckPanel, {
          className: undefined,
          unavailable: false,
          retrying: true,
          onRetry: () => undefined
        })
      )
    );

    expect(markup).toContain("Checking session");
    expect(markup).not.toContain("<button");
  });
});

describe("an interface older than its server", () => {
  it.each([
    ["en", "The application was updated", "Reload"],
    ["de", "Die Anwendung wurde aktualisiert", "Neu laden"]
  ] as const)("shows one notice with a reload action in %s", (locale, title, action) => {
    const markup = renderInUiRoot(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(OutdatedInterfaceBanner, { onReload: () => undefined })
      )
    );
    expect(markup.match(/role="status"/gu)).toHaveLength(1);
    expect(markup).toContain(title);
    expect(markup).toMatch(new RegExp(`<button[^>]*>${action}</button>`, "u"));
  });
});
