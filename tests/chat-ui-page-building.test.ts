import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  PageSaveCardView,
  pageBuildingSurface,
  pageSurface,
  pageBuildingSurfaceRendering,
  readPageSave,
  type PageSave
} from "@work-shape/catalyst-chat-ui/pages";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// A Page from the agent's first save on, and a Page that became an App: the place the surface
// gives a Page while its first save builds, and the card of a save that wrote the App's draft.
// Fails without A3: there was no surface before the first revision, and a save knew no App.

const { t } = createTranslationContext("en");

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

const built = { output: { pageId: "page-1", number: 2, fileSetId: "set-2" } };
const refused = {
  output: {
    errors: [
      { file: "src/routes/index.tsx", line: 12, column: 3, message: "Expected '}'" },
      { file: "app.yaml", message: "The kit version '9.9.9' is not released." }
    ]
  }
};

describe("the building Page beside the conversation", () => {
  const shown = (surface: ReturnType<typeof pageBuildingSurface>, locale?: "de") =>
    render(pageBuildingSurfaceRendering(surface).content, locale);
  const building = pageBuildingSurface("call-1", { name: "Offers" }, t);

  it("holds the place of the preview while the first save builds, in English and German", () => {
    expect(shown(building)).toContain('data-preview-state="starting"');
    expect(shown(building)).toContain("Building the preview");
    expect(shown(building, "de")).toContain("Die Vorschau wird gebaut");
  });

  it("says what refused the save, or that it failed", () => {
    const refusedMarkup = shown({ ...building, buildErrors: refused.output.errors });
    expect(refusedMarkup).toContain("The preview could not be built");
    expect(refusedMarkup).toContain("2 build errors");
    expect(shown({ ...building, failed: true })).toContain("The preview could not be opened");
  });
});

describe("the card of a save of a Page that became an App", () => {
  const card = (save: PageSave, props: { onOpen?: () => void } = {}, locale?: "de") =>
    render(createElement(PageSaveCardView, { save, shown: false, onOpen: props.onOpen }), locale);

  it("says that the save wrote the draft of the App, which is shown as the App and not opened here", () => {
    const intoApp = readPageSave({
      args: { name: "Offers" },
      result: {
        output: {
          ...built.output,
          app: { name: "offers", title: "Offer desk", saved: true, revision: 3 }
        }
      }
    });
    expect(intoApp).toMatchObject({ app: { title: "Offer desk", saved: true, revision: 3 } });

    const markup = card(intoApp, { onOpen: () => undefined });
    expect(markup).toContain(">Saved to the draft of Offer desk</p>");
    expect(markup).not.toMatch(/>[^<]*revision/iu);
    expect(markup).not.toContain("<button");
    expect(card(intoApp, {}, "de")).toContain(">Im Entwurf von Offer desk gespeichert</p>");

    const notWritten = readPageSave({
      args: { name: "Offers" },
      result: {
        output: {
          ...built.output,
          app: { name: "offers", title: "Offer desk", saved: false, message: "Changed elsewhere" }
        }
      }
    });
    expect(card(notWritten, { onOpen: () => undefined })).toContain(
      "The draft of Offer desk was not changed. The agent says why."
    );
  });
});

// OPEN-1f design review: one name for one thing. The card and the panel head read "umsatz", the
// path the agent opened, while Save as app proposed "Umsatzübersicht 2026".
describe("the name of a built preview", () => {
  const opened = (output: Record<string, unknown>) =>
    readPageSave({ args: { path: "apps/umsatz" }, result: { output } });

  it("is the folder's own name on the card and in the panel head", () => {
    const save = opened({ ...built.output, title: "Umsatzübersicht 2026" });
    if (save.state !== "built") throw new Error("expected a built preview");

    const surface = pageSurface("conv-1", save, t);
    expect(surface).toMatchObject({ title: "Umsatzübersicht 2026", path: "apps/umsatz" });
    const markup = render(createElement(PageSaveCardView, { save, shown: false }));
    expect(markup).toContain('aria-label="Umsatzübersicht 2026"');
    expect(markup).toContain(">Umsatzübersicht 2026</p>");
    expect(markup).not.toContain("umsatz<");
  });

  it("stays the path where the build refused it, because nothing was built to name itself", () => {
    const markup = render(
      createElement(PageSaveCardView, { save: opened(refused.output), shown: false })
    );
    expect(markup).toContain('aria-label="apps/umsatz"');
  });
});
