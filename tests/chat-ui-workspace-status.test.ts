import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import { ApiError } from "@work-shape/catalyst-api-client";
import {
  renderToStaticMarkup as renderInUiRoot,
  TranslationProvider
} from "./chat-ui-render-harness";
import {
  apiErrorReason,
  ConfigCheckPanel,
  SessionCheckPanel,
  signInRefusal
} from "./support/chat-ui";

function render(locale: "en" | "de", panel: ReturnType<typeof createElement>): string {
  return renderInUiRoot(createElement(TranslationProvider, { children: null, locale }, panel));
}

describe("workspace config status", () => {
  const idle = { retrying: false, onRetry: () => undefined, onReload: () => undefined };

  it("shows no platform branding and no action until customer config is available", () => {
    const markup = render(
      "en",
      createElement(ConfigCheckPanel, { className: undefined, failure: undefined, ...idle })
    );
    expect(markup).not.toContain("Workshape Catalyst");
    expect(markup).not.toContain("<button");
  });

  it("offers a retry and a reload when the load failed, and holds the retry while one runs", () => {
    const failed = render(
      "en",
      createElement(ConfigCheckPanel, { className: undefined, failure: "unavailable", ...idle })
    );
    expect(failed.match(/role="alert"/gu)).toHaveLength(1);
    expect(failed.match(/<button/gu)).toHaveLength(2);

    const retrying = render(
      "en",
      createElement(ConfigCheckPanel, {
        className: undefined,
        failure: "unavailable",
        ...idle,
        retrying: true
      })
    );
    expect(retrying).toMatch(/<button[^>]*disabled=""[^>]*>Try again<\/button>/u);
    expect(retrying).not.toMatch(/<button[^>]*disabled=""[^>]*>Reload<\/button>/u);
  });
});

describe("workspace session status", () => {
  it("offers one manual retry once the service is unavailable, and none while the first check runs", () => {
    const panel = (unavailable: boolean, retrying: boolean) =>
      render(
        "en",
        createElement(SessionCheckPanel, {
          className: undefined,
          unavailable,
          retrying,
          onRetry: () => undefined
        })
      );
    expect(panel(true, false).match(/<button/gu)).toHaveLength(1);
    expect(panel(false, true)).not.toContain("<button");
  });
});

// ACCEPT-2e C-4: Lena, disabled, signed in and saw "Dienst nicht erreichbar"; Noah, invited
// without a password, read the English "Invalid email or password". Both now read who helps.
describe("a person who cannot get in", () => {
  it("is told their account is disabled, and may sign out", () => {
    const markup = render(
      "de",
      createElement(SessionCheckPanel, {
        className: undefined,
        unavailable: true,
        disabled: true,
        retrying: false,
        onRetry: () => undefined,
        onSignOut: () => undefined
      })
    );
    expect(markup).toContain("Dein Konto ist deaktiviert");
    expect(markup).not.toContain("Dienst nicht erreichbar");
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
    expect(de).not.toContain("Invalid email or password");
    expect(de).toContain("Einladungsmail");
  });
});
