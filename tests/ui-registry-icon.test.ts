import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IconRegistryProvider, RegistryIcon, genericIcons } from "@work-shape/catalyst-ui";
import {
  contrastRatio,
  createThemeTokens,
  DEFAULT_THEME_INPUTS,
  parseHexColor
} from "@work-shape/catalyst-ui/theme";

// The icon registry's resolution order, and the file-type pages' colours.

describe("RegistryIcon", () => {
  const Mark = () => createElement("svg", { "data-mark": "ledger" });
  const icon = (props: Parameters<typeof RegistryIcon>[0], icons = {}) =>
    renderToStaticMarkup(
      createElement(IconRegistryProvider, {
        icons: { ledger: Mark, ...icons },
        children: createElement(RegistryIcon, props)
      })
    );
  const generic = (key: keyof typeof genericIcons) =>
    renderToStaticMarkup(createElement(genericIcons[key], { "aria-hidden": true }));
  const shape = (markup: string) => markup.replace(/^<svg[^>]*>/u, "");

  it("shows the registered icon, then the fallback, then the generic step", () => {
    expect(icon({ name: "ledger" })).toContain('data-mark="ledger"');
    expect(shape(icon({ name: "outlook", fallback: "mail" }))).toBe(shape(generic("mail")));
    expect(shape(icon({ name: "unknown" }))).toBe(shape(generic("step")));
  });

  it.each(["file", "skill"] as const)(
    "resolves an unknown key of the family %s to the family's generic icon",
    (family) => {
      expect(shape(icon({ name: "unknown", family }))).toBe(shape(generic(family)));
      // A registered key and a registered fallback come before the family.
      expect(icon({ name: "ledger", family })).toContain('data-mark="ledger"');
      expect(shape(icon({ name: "unknown", fallback: "mail", family }))).toBe(
        shape(generic("mail"))
      );
    }
  );

  it("lets an application replace a family's icon", () => {
    expect(icon({ name: "unknown", family: "skill" }, { skill: Mark })).toContain(
      'data-mark="ledger"'
    );
  });
});

describe("file-type pages", () => {
  it.each(["light", "dark"] as const)(
    "keep a white glyph readable on every page colour and the page off the surface in %s",
    (mode) => {
      const inputs = DEFAULT_THEME_INPUTS[mode];
      const tokens = createThemeTokens(inputs, mode);
      const hex = (value: string) => {
        const colour = parseHexColor(value);
        if (!colour) {
          throw new Error(`${value} is not a hex colour`);
        }
        return colour;
      };
      const glyph = hex(tokens["--file-foreground"]);

      for (const name of [
        "--file-sheet",
        "--file-document",
        "--file-slides",
        "--file-pdf"
      ] as const) {
        const page = hex(tokens[name]);
        expect([name, contrastRatio(page, glyph) >= 3]).toEqual([name, true]);
        expect([name, contrastRatio(page, hex(inputs.surfaceColor)) >= 3]).toEqual([name, true]);
      }
    }
  );
});
