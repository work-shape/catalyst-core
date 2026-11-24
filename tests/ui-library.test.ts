import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as library from "@work-shape/catalyst-ui";
import { galleryGroups, UiGallery, type GallerySectionId } from "@work-shape/catalyst-ui/gallery";

const { Dialog, Field, Input, Picker, PickerButton, Switch, Avatar, UiRoot } = library;
const { Tooltip, TooltipContent, TooltipTrigger, uiLabelsDe, uiLabelsEn, scrollEdgeFadeStyle } =
  library;

describe("UiRoot", () => {
  it("gives a dialog an overlay container of its own, inside the dialog", () => {
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
      "Dialog",
      createElement(Dialog, {
        open: true,
        title: "Title",
        onClose: () => undefined,
        children: "Body"
      })
    ],
    ["Field", createElement(Field, { label: "Name", children: "c" })]
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

  // ACCEPT-2d: "Pflichtfeld" stood under required fields that were filled already.
  it("says a field is required only while its control holds no text", () => {
    const field = (value: string) =>
      render(
        createElement(Field, {
          label: "Name",
          required: true,
          children: createElement(Input, { value, onChange: () => undefined })
        }),
        uiLabelsDe
      );
    for (const [empty, filled] of [
      [field(""), field("Richtlinien")],
      [field("   "), field(" x ")]
    ] as const) {
      expect(empty).toContain(uiLabelsDe.required);
      expect(filled).not.toContain(uiLabelsDe.required);
      // The control and the mark stay required either way.
      expect(filled).toMatch(/<input[^>]*\srequired=""/u);
    }
  });

  it("counts a number as filled, and a number that is none as empty", () => {
    const field = (value: number) =>
      render(
        createElement(Field, {
          label: "Limit",
          required: true,
          children: createElement(Input, { type: "number", value, onChange: () => undefined })
        }),
        uiLabelsDe
      );
    expect(field(0)).not.toContain(uiLabelsDe.required);
    expect(field(25)).not.toContain(uiLabelsDe.required);
    expect(field(Number.NaN)).toContain(uiLabelsDe.required);
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
    expect(markup).toMatch(/<input[^>]*aria-invalid="true"/u);
    expect(attribute(markup, "input", "aria-describedby")).toBe(attribute(markup, "p", "id"));
  });

  it("reads a switch that can be partly on as a tri-state check box, and a plain one as a switch", () => {
    const control = (props: { checked?: boolean; mixed?: boolean }) => {
      const markup = render(createElement(Switch, { "aria-label": "All tools", ...props }));
      return [attribute(markup, "button", "role"), attribute(markup, "button", "aria-checked")];
    };

    expect(control({ checked: true })).toEqual(["switch", "true"]);
    expect(control({ checked: false })).toEqual(["switch", "false"]);
    // Its role stays the same in every state, so a state change is not read as a new control.
    expect(control({ checked: true, mixed: false })).toEqual(["checkbox", "true"]);
    expect(control({ checked: false, mixed: false })).toEqual(["checkbox", "false"]);
    expect(control({ checked: true, mixed: true })).toEqual(["checkbox", "mixed"]);
  });

  it("takes initials from the name", () => {
    const avatar = (kind: "person" | "workspace" | "agent" | "app" | "workflow", name: string) =>
      render(createElement(Avatar, { kind, name }));

    expect(avatar("person", "Maria Schmidt")).toContain(">MS<");
    expect(avatar("workspace", "marketing")).toContain(">MA<");
    expect(avatar("person", " ")).toContain(">?<");
  });
});

describe("Picker", () => {
  it("shows only its button while closed and reports no search the reader did not type", () => {
    const searches: string[] = [];
    const markup = renderToStaticMarkup(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(Picker, {
          search: true,
          onSearchChange: (search) => searches.push(search),
          options: [{ value: "alpha", label: "Alpha" }],
          value: undefined,
          onValueChange: () => undefined,
          children: createElement(PickerButton, {
            label: "Skill",
            placeholder: "Choose a skill",
            value: undefined
          })
        })
      )
    );

    expect(markup).toContain('aria-label="Skill: Choose a skill"');
    expect(markup).not.toContain("Alpha");
    // Typing, and the empty search a closing picker reports, need a browser.
    expect(searches).toEqual([]);
  });
});

describe("SurfaceFrame", () => {
  it("takes product-owned props and no Radix type", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../packages/ui/src/structure/surface-frame.tsx", import.meta.url)),
      "utf8"
    );
    const imports = [...source.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);

    expect(imports.every((path) => path === "react" || path?.startsWith("../") === true)).toBe(
      true
    );
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

  it("renders every entry", () => {
    const render = (initialSection: GallerySectionId) =>
      renderToStaticMarkup(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(UiGallery, {
            initialMode: "dark",
            initialLanguage: "en",
            initialSection
          })
        )
      );

    for (const group of galleryGroups) {
      const markup = render(group.id);
      for (const entry of group.entries) {
        expect(markup).toContain(`data-gallery-entry="${entry.name}"`);
      }
    }
    expect(render("samples")).toContain('data-gallery-sample="settings-form"');
  });
});

function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

describe("scrollEdgeFadeStyle", () => {
  it("fades the edges that hide content, and only those", () => {
    const both = scrollEdgeFadeStyle({ above: true, below: true });
    const top = scrollEdgeFadeStyle({ above: true, below: false });
    const bottom = scrollEdgeFadeStyle({ above: false, below: true });

    expect(both?.maskImage).toBe(
      "linear-gradient(to bottom, transparent 0, black 1rem, black calc(100% - 1rem), transparent 100%)"
    );
    expect(top?.maskImage).toBe(
      "linear-gradient(to bottom, transparent 0, black 1rem, black 100%)"
    );
    expect(bottom?.maskImage).toBe(
      "linear-gradient(to bottom, black 0, black calc(100% - 1rem), transparent 100%)"
    );
    expect(both?.WebkitMaskImage).toBe(both?.maskImage);
    expect(scrollEdgeFadeStyle({ above: false, below: false })).toBeUndefined();
  });
});

describe("QrCode", () => {
  it("draws the code in the page as one SVG path, named for a screen reader, with no outside address", () => {
    const value = "otpauth://totp/Catalyst:anna%40example.test?secret=JBSWY3DPEHPK3PXP";
    const html = renderToStaticMarkup(
      createElement(library.QrCode, { value, label: "Authenticator code" })
    );
    expect(html).toMatch(/^<svg role="img" aria-label="Authenticator code"/u);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("http");
    expect(html).not.toContain("JBSWY3DPEHPK3PXP");
    // A version's side is 17 plus four modules a version, inside a quiet zone of four.
    const side = Number(/viewBox="0 0 (\d+) \1"/u.exec(html)?.[1]) - 8;
    expect(side).toBeGreaterThanOrEqual(21);
    expect((side - 17) % 4).toBe(0);
    expect(html.match(/<path /gu)).toHaveLength(1);
  });

  it("draws a different code for a different value, and the same for the same", () => {
    const draw = (value: string) =>
      renderToStaticMarkup(createElement(library.QrCode, { value, label: "Code" }));
    expect(draw("first value")).not.toBe(draw("second value"));
    expect(draw("same value")).toBe(draw("same value"));
  });
});
