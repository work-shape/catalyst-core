import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as library from "@vivd-catalyst/ui";
import { galleryGroups, UiGallery, type GallerySectionId } from "@vivd-catalyst/ui/gallery";
import { createThemeTokens, DEFAULT_THEME_INPUTS } from "@vivd-catalyst/ui/theme";

const { Dialog, HoverCard, HoverCardContent, HoverCardTrigger, IconButton, UiRoot } = library;
const { Tooltip, TooltipContent, TooltipTrigger, uiLabelsDe, uiLabelsEn } = library;
const { Avatar, Banner, Checkbox, Chip, ConfirmDialog, Field, Input, RadioGroup } = library;
const { DropdownMenu, DropdownMenuContent, Picker, Popover, PopoverContent, SkeletonList } =
  library;

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
    ["IconButton", createElement(IconButton, { label: "Close" }, "x")],
    [
      "ConfirmDialog",
      createElement(ConfirmDialog, {
        open: true,
        title: "Title",
        confirmLabel: "Delete",
        onConfirm: () => undefined,
        onClose: () => undefined,
        children: "Body"
      })
    ],
    ["Popover", createElement(Popover, { open: true, children: createElement(PopoverContent) })],
    [
      "DropdownMenu",
      createElement(DropdownMenu, {
        open: true,
        children: createElement(DropdownMenuContent, { children: "c" })
      })
    ],
    [
      "Picker",
      createElement(Picker, {
        options: [],
        value: undefined,
        onValueChange: () => undefined,
        children: createElement("button")
      })
    ],
    ["Field", createElement(Field, { label: "Name", children: "c" })],
    ["Chip", createElement(Chip, null, "c")],
    ["Banner", createElement(Banner, null, "c")],
    ["Skeleton", createElement(SkeletonList)]
  ])("refuses to render %s outside a UiRoot and names it", (_name, element) => {
    expect(() => renderToStaticMarkup(element)).toThrow(/must be rendered inside UiRoot/u);
  });
});

describe("Button", () => {
  it("is a plain button unless the caller makes it a submit button", () => {
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(library.Button, null, "Plain"),
        createElement(library.Button, { type: "submit" }, "Submit"),
        createElement(
          library.Button,
          { asChild: true },
          createElement("a", { href: "/next" }, "Link")
        )
      )
    );
    expect(html).toContain('type="button"');
    expect(html).toContain('type="submit"');
    expect(html.match(/type="/g)).toHaveLength(2);
  });
});

describe("form components", () => {
  const render = (element: ReturnType<typeof createElement>, labels = uiLabelsEn) =>
    renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels }, element));
  const attribute = (markup: string, tag: string, name: string) =>
    new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`, "u").exec(markup)?.[1];

  it("ties a field's label and hint to its control and marks it required", () => {
    const markup = render(
      createElement(Field, {
        label: "Name",
        hint: "Shown in the list",
        required: true,
        children: createElement(Input)
      }),
      uiLabelsDe
    );
    const hintId = attribute(markup, "p", "id");

    expect(attribute(markup, "input", "id")).toBe(attribute(markup, "label", "for"));
    expect(attribute(markup, "input", "aria-describedby")).toBe(hintId);
    expect(markup).toMatch(/<input[^>]*\srequired=""/u);
    expect(markup).not.toContain('aria-invalid="');
    expect(markup).toContain(`<span class="sr-only">${uiLabelsDe.required}</span>`);
    expect(markup).toContain(`<p id="${hintId}" class="text-caption text-muted-foreground">`);
  });

  it("shows a field's error in the hint's place, announces it and marks the control invalid", () => {
    const markup = render(
      createElement(Field, {
        label: "Name",
        hint: "Shown in the list",
        error: "Too short",
        optional: true,
        children: createElement(Input)
      })
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Too short");
    expect(markup).not.toContain("Shown in the list");
    expect(markup).toMatch(/<input[^>]*aria-invalid="true"/u);
    expect(attribute(markup, "input", "aria-describedby")).toBe(attribute(markup, "p", "id"));
    expect(markup).toContain(`>${uiLabelsEn.optional}</span>`);
  });

  it("leaves a control outside a field as the caller wrote it", () => {
    const markup = render(createElement(Input, { id: "own", "aria-describedby": "note" }));

    expect(attribute(markup, "input", "id")).toBe("own");
    expect(attribute(markup, "input", "aria-describedby")).toBe("note");
    expect(markup).not.toMatch(/\s(?:required|aria-invalid)="/u);
  });

  it("gives a checkbox its three states and names it by its label", () => {
    const state = (checked: boolean | "indeterminate") =>
      attribute(
        render(createElement(Checkbox, { checked, label: "Select all", description: "3 rows" })),
        "button",
        "aria-checked"
      );
    const markup = render(createElement(Checkbox, { label: "Select all", description: "3 rows" }));

    expect([state(false), state(true), state("indeterminate")]).toEqual(["false", "true", "mixed"]);
    expect(attribute(markup, "button", "id")).toBe(attribute(markup, "label", "for"));
    expect(attribute(markup, "button", "aria-describedby")).toBe(attribute(markup, "p", "id"));
  });

  it("renders a radio group with one radio per option and its hint as the description", () => {
    const markup = render(
      createElement(RadioGroup, {
        label: "Visibility",
        hint: "Changeable later",
        value: "private",
        options: [
          { value: "open", label: "Open", description: "Everyone" },
          { value: "private", label: "Private", disabled: true }
        ]
      })
    );

    expect(attribute(markup, "div", "role")).toBe("radiogroup");
    expect(markup.match(/role="radio"/gu)).toHaveLength(2);
    expect(markup).toMatch(/role="radio" aria-checked="false"[^>]*value="open"/u);
    expect(markup).toMatch(/role="radio" aria-checked="true"[^>]*value="private"/u);
    expect(markup).toMatch(
      /<button[^>]*value="private"[^>]*disabled=""|disabled=""[^>]*value="private"/u
    );
  });

  it("draws a person round and every thing as a rounded square, with initials from the name", () => {
    const avatar = (kind: "person" | "workspace" | "agent" | "app", name: string) =>
      render(createElement(Avatar, { kind, name }));

    expect(avatar("person", "Maria Schmidt")).toMatch(/rounded-full[^>]*>MS</u);
    for (const kind of ["workspace", "agent", "app"] as const) {
      expect(avatar(kind, "marketing")).toMatch(/rounded-md[^>]*>MA</u);
    }
    expect(avatar("person", " ")).toContain(">?<");
  });
});

describe("Banner", () => {
  const inRoot = (banner: ReactNode) =>
    renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, banner));

  it("draws a line without a box: quiet text, and the tone on the icon alone", () => {
    const line = inRoot(
      createElement(
        Banner,
        { layout: "line", tone: "warning", icon: createElement("svg") },
        "Will be deleted soon."
      )
    );
    const banner = /<div role="status" data-tone="warning" class="([^"]*)"/u.exec(line)?.[1];
    expect(banner?.split(" ")).toEqual(
      expect.arrayContaining(["text-caption", "text-muted-foreground"])
    );
    expect(banner).not.toMatch(/border|bg-|rounded|text-warning/u);
    expect(line).toMatch(/<span class="[^"]*text-warning[^"]*"><svg>/u);
    expect(line).not.toContain("<button");
  });

  it("keeps the box and the tone's fill for the other layouts", () => {
    const inline = inRoot(createElement(Banner, { tone: "warning" }, "Read-only."));
    expect(inline).toMatch(/class="[^"]*border-warning-border bg-warning-soft[^"]*rounded-md/u);
    expect(inline).not.toContain("text-muted-foreground");
  });
});

describe("SurfaceFrame", () => {
  it("puts its slots in one order under a header of the shared height", () => {
    const slot = (text: string) => createElement("span", null, text);
    const markup = renderToStaticMarkup(
      createElement(
        library.SurfaceFrame,
        {
          leading: slot("leading"),
          title: "name",
          subtitle: "subtitle",
          actions: slot("actions"),
          fullscreen: slot("fullscreen"),
          close: slot("close")
        },
        slot("content")
      )
    );
    const order = ["leading", "name", "subtitle", "actions", "fullscreen", "close", "content"];
    const positions = order.map((text) => markup.indexOf(`>${text}<`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(markup).toContain("h-(--layout-header)");
    expect(markup).toMatch(/<h2 class="[^"]*text-heading[^"]*">name</u);
    expect(markup).toMatch(/<p class="[^"]*text-caption text-muted-foreground[^"]*">subtitle</u);
  });

  it("takes product-owned props and no Radix type", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../packages/ui/src/structure/surface-frame.tsx", import.meta.url)),
      "utf8"
    );
    const imports = [...source.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);

    expect(imports).toEqual(["react", "../cn"]);
  });
});

describe("UI gallery", () => {
  // The root is what the gallery's panels are, and `ChartFieldError` is an error class, so
  // neither has an entry of its own.
  const withoutEntry = new Set(["UiRoot", "ChartFieldError"]);
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
    const render = (initialSection: GallerySectionId) =>
      renderToStaticMarkup(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(UiGallery, {
            initialMode: "dark",
            initialLanguage: language,
            initialSection
          })
        )
      );

    for (const group of galleryGroups) {
      const markup = render(group.id);
      expect(markup).toContain(language === "de" ? "UI-Bibliothek" : "UI library");
      expect(markup).toContain('data-gallery-mode="dark"');
      for (const entry of group.entries) {
        expect(markup).toContain(`data-gallery-entry="${entry.name}"`);
      }
    }
    // The three sample pages show once each, under the one base theme.
    const samples = render("samples");
    for (const sample of ["build-list", "asset-page", "settings-form"]) {
      expect(samples).toContain(`data-gallery-sample="${sample}"`);
    }
    expect(samples.split('data-gallery-mode="dark"')).toHaveLength(4);
    expect(samples).not.toContain("data-gallery-theme");
  });
});

function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}
