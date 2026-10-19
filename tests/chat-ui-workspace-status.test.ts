import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { ApiError } from "@work-shape/catalyst-api-client";
import {
  renderToStaticMarkup as renderInUiRoot,
  TranslationProvider
} from "./chat-ui-render-harness";
import {
  apiErrorReason,
  ConfigCheckPanel,
  OutdatedInterfaceBanner,
  SessionCheckPanel,
  signInRefusal
} from "./support/chat-ui";

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
    expect(markup).not.toContain("Workshape Catalyst");
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
    // The banner's tinted fill floats over the page on an opaque surface of its own.
    expect(markup).toMatch(/<div class="[^"]*bg-popover[^"]*"><div role="status"/u);
  });
});

// ACCEPT-2e C-4: Lena, disabled, signed in and saw "Dienst nicht erreichbar"; Noah, invited
// without a password, read the English "Invalid email or password". Both now read who helps.
describe("a person who cannot get in", () => {
  it.each([
    ["en", "Your account is disabled", "Ask an admin of your organization", "Sign out"],
    ["de", "Dein Konto ist deaktiviert", "Bitte einen Admin deiner Organisation", "Abmelden"]
  ] as const)("is told their account is disabled, and may sign out, in %s", (locale, ...texts) => {
    const markup = renderInUiRoot(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(SessionCheckPanel, {
          className: undefined,
          unavailable: true,
          disabled: true,
          retrying: false,
          onRetry: () => undefined,
          onSignOut: () => undefined
        })
      )
    );
    for (const text of texts) expect(markup).toContain(text);
    expect(markup).not.toContain(
      locale === "de" ? "Dienst nicht erreichbar" : "Service unavailable"
    );
    expect(markup.match(/<button/gu)).toHaveLength(1);
  });

  it("is known as disabled by the reason the instance names, not by its sentence", () => {
    const refusal = (reason: string | undefined) =>
      new ApiError(403, "User is disabled", {
        error: {
          code: "FORBIDDEN",
          message: "User is disabled",
          ...(reason === undefined ? {} : { details: { reason } })
        }
      });
    expect(apiErrorReason(refusal("user_disabled"))).toBe("user_disabled");
    expect(apiErrorReason(refusal(undefined))).toBeUndefined();
    expect(apiErrorReason(new Error("down"))).toBeUndefined();
  });

  it("reads a wrong password in the person's language, with how an invited person gets in", () => {
    const refused = {
      ok: false,
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid email or password"
    };
    const de = signInRefusal(refused, createTranslationContext("de").t);
    expect(de).toContain("E-Mail oder Passwort stimmt nicht.");
    expect(de).toContain("Einladungsmail");
    expect(de).toContain("Ein Admin deiner Organisation");
    expect(signInRefusal(refused, createTranslationContext("en").t)).toContain(
      "If you were invited, set your password"
    );
  });
});
