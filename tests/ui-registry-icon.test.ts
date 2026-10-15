import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  IconRegistryProvider,
  RegistryIcon,
  UiRoot,
  genericIcons,
  uiLabelsEn
} from "@work-shape/catalyst-ui";
import { UiGallery } from "@work-shape/catalyst-ui/gallery";
import {
  contrastRatio,
  createThemeTokens,
  DEFAULT_THEME_INPUTS,
  parseHexColor
} from "@work-shape/catalyst-ui/theme";

// The file-type icons of the icon registry and the registry's gallery entry. The registry's own
// resolution order is held in ui-flow.test.ts.

describe("file-type icons", () => {
  const fileTypes = [
    "spreadsheet",
    "document",
    "presentation",
    "pdf",
    "image",
    "archive",
    "text",
    "file"
  ] as const;
  const pageFill: Record<(typeof fileTypes)[number], string> = {
    spreadsheet: "fill-file-sheet",
    document: "fill-file-document",
    presentation: "fill-file-slides",
    pdf: "fill-file-pdf",
    image: "fill-muted-foreground",
    archive: "fill-muted-foreground",
    text: "fill-muted-foreground",
    file: "fill-muted-foreground"
  };
  const render = (props: Parameters<typeof RegistryIcon>[0]) =>
    renderToStaticMarkup(createElement(RegistryIcon, props));

  it.each(fileTypes)("ships an icon of its own for %s", (type) => {
    const markup = render({ name: type, family: "file", className: "size-4" });

    expect(markup).toContain(`data-file-type="${type}"`);
    expect(markup).toContain('aria-hidden="true"');
    // It fills a square box, so the size class of any other icon fits it.
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(/^<svg[^>]*class="([^"]*)"/u.exec(markup)?.[1]?.split(" ")).toContain("size-4");
  });

  it("draws every file type differently", () => {
    const drawings = fileTypes.map((type) =>
      render({ name: type }).replace(/data-file-type="[a-z]+"/u, "")
    );

    expect(new Set(drawings).size).toBe(fileTypes.length);
  });

  it("shows the neutral page for a file type nobody registered", () => {
    expect(render({ name: "video", family: "file" })).toContain('data-file-type="file"');
    expect(render({ family: "file" })).toContain('data-file-type="file"');
  });

  it("colours the four office types from their tokens and the rest from the neutral ones", () => {
    for (const type of fileTypes) {
      const markup = render({ name: type });

      expect([type, markup.includes(pageFill[type])]).toEqual([type, true]);
      expect([type, /#[0-9a-f]{3,8}\b|rgb\(|white|black/iu.test(markup)]).toEqual([type, false]);
      expect(markup).not.toContain("<text");
    }
  });

  it("lets a client assembly register its own mark for a file type", () => {
    const Mark = () => createElement("svg", { "data-mark": "vendor-sheet" });
    const markup = renderToStaticMarkup(
      createElement(IconRegistryProvider, {
        icons: { spreadsheet: Mark },
        children: createElement(RegistryIcon, { name: "spreadsheet", family: "file" })
      })
    );

    expect(markup).toContain('data-mark="vendor-sheet"');
  });

  it.each(["light", "dark"] as const)(
    "keeps a white glyph readable on every page colour and the page off the surface in %s",
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

describe("RegistryIcon in the gallery", () => {
  const markup = renderToStaticMarkup(
    createElement(
      UiRoot,
      { mode: "light", labels: uiLabelsEn },
      createElement(UiGallery, {
        initialMode: "light",
        initialLanguage: "en",
        initialSection: "status"
      })
    )
  );

  it("shows every key of the registry", () => {
    const fileTypes = new Set([
      "spreadsheet",
      "document",
      "presentation",
      "pdf",
      "image",
      "archive",
      "text",
      "file"
    ]);
    const missing = Object.keys(genericIcons).filter(
      (key) =>
        !markup.includes(`data-gallery-sample="icon-${fileTypes.has(key) ? "file-" : ""}${key}"`)
    );

    expect(missing).toEqual([]);
  });

  it("shows the fallback of every family", () => {
    for (const family of ["file", "service", "skill", "tool"]) {
      expect(markup).toContain(`data-gallery-sample="icon-family-${family}"`);
    }
  });
});

describe("kind icons", () => {
  // One icon per kind, the same in Studio, on the rail and on the canvas.
  it.each([
    ["agent", "bot"],
    ["skill", "book-open"],
    ["connection", "plug"],
    ["workflow", "workflow"],
    ["app", "layout-grid"],
    ["datastore", "database"],
    ["guardrail", "shield-check"]
  ])("draws the kind %s as %s", (kind, lucideName) => {
    expect(renderToStaticMarkup(createElement(RegistryIcon, { name: kind }))).toContain(
      `lucide-${lucideName}`
    );
  });
});
