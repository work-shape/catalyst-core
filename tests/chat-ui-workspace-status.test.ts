import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup as renderInUiRoot } from "./chat-ui-render-harness";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import {
  ConfigCheckPanel,
  OutdatedInterfaceBanner,
  SessionCheckPanel
} from "../packages/chat-ui/src/workspace/workspace-chrome";

describe("workspace config status", () => {
  const idle = { retrying: false, onRetry: () => undefined, onReload: () => undefined };

  it("keeps the loading state neutral until customer config is available", () => {
    const markup = renderInUiRoot(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ConfigCheckPanel, { className: undefined, failure: undefined, ...idle })
      )
    );

    expect(markup).toContain("Loading configuration…");
    expect(markup).not.toContain("Vivd Catalyst");
    expect(markup).not.toContain("lucide-shield");
    expect(markup).not.toContain("<button");
  });

  it.each([
    [
      "en",
      "Could not load workspace",
      "Please refresh the page and try again.",
      "Try again",
      "Reload"
    ],
    [
      "de",
      "Arbeitsbereich konnte nicht geladen werden",
      "Bitte lade die Seite neu und versuche es noch einmal.",
      "Erneut versuchen",
      "Neu laden"
    ]
  ] as const)("offers a retry and a reload when the load failed in %s", (locale, ...texts) => {
    const markup = renderInUiRoot(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(ConfigCheckPanel, { className: undefined, failure: "unavailable", ...idle })
      )
    );

    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
    for (const text of texts) {
      expect(markup).toContain(text);
    }
    expect(markup.match(/<button/gu)).toHaveLength(2);
  });

  it.each([
    ["en", "The application was updated", "Try again", "Reload"],
    ["de", "Die Anwendung wurde aktualisiert", "Erneut versuchen", "Neu laden"]
  ] as const)(
    "reads as the outdated-tab notice for another release's answer in %s",
    (locale, ...texts) => {
      const markup = renderInUiRoot(
        createElement(
          TranslationProvider,
          { children: null, locale },
          createElement(ConfigCheckPanel, { className: undefined, failure: "outdated", ...idle })
        )
      );

      for (const text of texts) {
        expect(markup).toContain(text);
      }
      expect(markup.match(/<button/gu)).toHaveLength(2);
    }
  );

  it("holds the retry while one is under way", () => {
    const markup = renderInUiRoot(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ConfigCheckPanel, {
          className: undefined,
          failure: "unavailable",
          ...idle,
          retrying: true
        })
      )
    );

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Try again<\/button>/u);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Reload<\/button>/u);
  });
});

describe("workspace session status", () => {
  it("shows a neutral localized failure with one manual retry", () => {
    const markup = renderInUiRoot(
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
    const markup = renderInUiRoot(
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
