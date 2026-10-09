import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as library from "@vivd-catalyst/ui";
import { galleryGroups, UiGallery } from "@vivd-catalyst/ui/gallery";
import { createThemeTokens, DEFAULT_THEME_INPUTS } from "@vivd-catalyst/ui/theme";

const { Dialog, HoverCard, HoverCardContent, HoverCardTrigger, IconButton, UiRoot } = library;
const { Tooltip, TooltipContent, TooltipTrigger, uiLabelsDe, uiLabelsEn } = library;

describe("UiRoot", () => {
  it("carries the theme on its own element and holds the overlay container as its last child", () => {
    const markup = renderToStaticMarkup(
      createElement(
        UiRoot,
        { theme: DEFAULT_THEME_INPUTS.dark, mode: "dark", labels: uiLabelsEn },
        createElement("p", null, "content")
      )
    );
    const tokens = createThemeTokens(DEFAULT_THEME_INPUTS.dark, "dark");

    expect(markup).toMatch(/^<div class="dark" style="[^"]*--popover:color-mix\(/u);
    expect(markup).toContain(`--background:${tokens["--background"]}`);
    expect(markup).toMatch(
      /<p>content<\/p><div data-catalyst-overlays="" class="contents"><\/div><\/div>$/u
    );
  });

  it("sets no tokens without a theme, so the stylesheet's default shows", () => {
    const markup = renderToStaticMarkup(
      createElement(UiRoot, { as: "main", mode: "light", labels: uiLabelsEn })
    );

    expect(markup).toMatch(/^<main class="">/u);
    expect(markup).not.toContain("style=");
  });

  it("gives a dialog a container of its own, inside the dialog", () => {
    const markup = renderToStaticMarkup(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsDe },
        createElement(Dialog, {
          open: true,
          title: "Title",
          onClose: () => undefined,
          children: "Body"
        })
      )
    );
    const dialog = /<dialog[\s\S]*<\/dialog>/u.exec(markup)?.[0] ?? "";

    expect(dialog).toContain('data-catalyst-overlays=""');
    expect(dialog).toContain(`aria-label="${uiLabelsDe.close}"`);
    // The close button is no tooltip trigger: the dialog focuses it on opening.
    expect(/<button[^>]*aria-label="Schließen"[^>]*>/u.exec(dialog)?.[0]).not.toContain(
      "data-state"
    );
    expect(markup.split('data-catalyst-overlays=""')).toHaveLength(3);
  });

  it.each([
    [
      "Tooltip",
      createElement(Tooltip, {
        open: true,
        children: createElement(
          Fragment,
          null,
          createElement(TooltipTrigger, null, "t"),
          createElement(TooltipContent, null, "c")
        )
      })
    ],
    [
      "HoverCard",
      createElement(HoverCard, {
        open: true,
        children: createElement(
          Fragment,
          null,
          createElement(HoverCardTrigger, null, "t"),
          createElement(HoverCardContent, null, "c")
        )
      })
    ],
    [
      "Dialog",
      createElement(Dialog, {
        open: true,
        title: "Title",
        onClose: () => undefined,
        children: "Body"
      })
    ],
    ["IconButton", createElement(IconButton, { label: "Close" }, "x")]
  ])("refuses to render %s outside a UiRoot and names it", (_name, element) => {
    expect(() => renderToStaticMarkup(element)).toThrow(/must be rendered inside UiRoot/u);
  });
});

describe("UI gallery", () => {
  // The root is what the gallery's panels are, so it has no entry of its own.
  const withoutEntry = new Set(["UiRoot"]);
  const exportedComponents = Object.entries(library)
    .filter(([name, value]) => /^[A-Z]/u.test(name) && isComponent(value))
    .map(([name]) => name)
    .filter((name) => !withoutEntry.has(name))
    .sort();
  const shown = galleryGroups.flatMap((group) =>
    group.entries.flatMap((entry) => entry.components)
  );

  it("has an entry for every component the library exports", () => {
    expect([...shown].sort()).toEqual(exportedComponents);
  });

  it("shows no component twice and names every entry once", () => {
    const names = galleryGroups.flatMap((group) => group.entries.map((entry) => entry.name));

    expect(shown.filter((name, index) => shown.indexOf(name) !== index)).toEqual([]);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it("has one group per library folder, in a fixed order", () => {
    expect(galleryGroups.map((group) => group.id)).toEqual([
      "foundations",
      "actions",
      "forms",
      "overlays",
      "navigation",
      "structure",
      "data",
      "status",
      "feedback"
    ]);
  });

  it.each(["de", "en"])("renders every entry in %s", (language) => {
    const markup = renderToStaticMarkup(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(UiGallery, { initialMode: "dark", initialLanguage: language })
      )
    );

    expect(markup).toContain(language === "de" ? "UI-Bibliothek" : "UI library");
    expect(markup).toContain('data-gallery-mode="dark"');
    for (const group of galleryGroups) {
      for (const entry of group.entries) {
        expect(markup).toContain(`data-gallery-entry="${entry.name}"`);
      }
    }
  });
});

function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}
