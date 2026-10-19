// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { useDocumentLanguage } from "./support/chat-ui";

// ACCEPT-FIX-10 K2: the page's `html lang` follows the interface language both ways, so a
// switch back to German leaves no "en" behind. An embedded shell never marks its host page.

function Language({ locale, ownsDocument }: { locale: LocaleCode; ownsDocument: boolean }) {
  useDocumentLanguage(locale, ownsDocument);
  return null;
}

const container = document.createElement("div");
const root = createRoot(container);

function show(locale: LocaleCode, ownsDocument = true) {
  act(() => root.render(createElement(Language, { locale, ownsDocument })));
}

afterEach(() => {
  document.documentElement.lang = "en";
});

describe("the document language", () => {
  it("follows a switch to German, back to English and to German again", () => {
    document.documentElement.lang = "en";
    show("de");
    expect(document.documentElement.lang).toBe("de");
    show("en");
    expect(document.documentElement.lang).toBe("en");
    show("de");
    expect(document.documentElement.lang).toBe("de");
  });

  it("leaves the host page alone where the shell does not own the document", () => {
    document.documentElement.lang = "fr";
    show("de", false);
    expect(document.documentElement.lang).toBe("fr");
  });
});
