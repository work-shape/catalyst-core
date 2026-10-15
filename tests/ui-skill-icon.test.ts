import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnowsHowTo, SkillIcon, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { UiGallery } from "@work-shape/catalyst-ui/gallery";

describe("SkillIcon", () => {
  const render = (props: Parameters<typeof SkillIcon>[0]) =>
    renderToStaticMarkup(createElement(SkillIcon, props));

  it("shows the page a shipped skill carries", () => {
    const markup = render({ icon: "spreadsheet" });

    expect(markup).toContain('data-file-type="spreadsheet"');
    expect(markup).toContain('data-skill-icon="spreadsheet"');
  });

  it("shows the generic skill icon without a key and for a key nobody registered", () => {
    const generic = render({});

    expect(generic).toContain('data-skill-icon="generic"');
    expect(generic).toContain("lucide-book-open");
    expect(render({ icon: "not-registered" })).toContain("lucide-book-open");
  });

  it("is hidden from assistive technology", () => {
    for (const markup of [render({ icon: "pdf", size: "lg" }), render({ size: "sm" })]) {
      expect(markup).toMatch(/^<span aria-hidden="true"/u);
    }
  });

  it("stands a file-type page bare, at every size", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const markup = render({ icon: "pdf", size });
      expect(markup).not.toContain("data-skill-icon-tile");
      expect(markup).not.toMatch(/\bbg-|rounded/u);
    }
  });

  it("puts a line icon on the neutral tile in lists, bare inline", () => {
    for (const size of ["md", "lg"] as const) {
      const markup = render({ icon: "guide", size });
      expect(markup).toContain("data-skill-icon-tile");
      expect(markup).toContain("bg-secondary");
      // Never tinted: colour means a file type and nothing else.
      expect(markup).not.toMatch(/bg-primary|bg-file-/u);
    }
    const inline = render({ icon: "guide", size: "sm" });
    expect(inline).not.toContain("data-skill-icon-tile");
    expect(inline).not.toMatch(/\bbg-|rounded/u);
  });

  it("draws a platform skill's line icon in ink and the generic book muted", () => {
    expect(render({ icon: "guide", size: "lg" })).toMatch(
      /^<span[^>]*data-skill-icon="guide"[^>]*text-foreground/u
    );
    for (const markup of [render({ size: "lg" }), render({ icon: "not-registered" })]) {
      expect(markup).toMatch(/^<span[^>]*data-skill-icon="generic"[^>]*text-muted-foreground/u);
      expect(markup).toContain("data-skill-icon-tile");
    }
  });
});

describe("KnowsHowTo", () => {
  const render = (skills: Parameters<typeof KnowsHowTo>[0]["skills"]) =>
    renderToStaticMarkup(createElement(KnowsHowTo, { label: "Knows how to", skills }));

  it("names each skill beside its icon, in a list the label names", () => {
    const markup = render([{ title: "Spreadsheets", icon: "spreadsheet" }, { title: "Plain" }]);

    expect(markup).toContain('<ul aria-label="Knows how to"');
    expect(markup.match(/<li/gu)).toHaveLength(2);
    expect(markup).toContain(">Spreadsheets<");
    expect(markup).toContain('data-file-type="spreadsheet"');
    expect(markup).toContain('data-skill-icon="generic"');
  });

  it("shows nothing for an agent without skills", () => {
    expect(render([])).toBe("");
  });
});

describe("the skill icon in the gallery", () => {
  it.each(["en", "de"] as const)("shows every size and the line of a card in %s", (language) => {
    const markup = renderToStaticMarkup(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(UiGallery, {
          initialMode: "light",
          initialLanguage: language,
          initialSection: "status"
        })
      )
    );

    for (const size of ["sm", "md", "lg"]) {
      expect(markup).toContain(`data-gallery-sample="skill-icon-${size}"`);
    }
    expect(markup).toContain(language === "de" ? "Weiß, wie man" : "Knows how to");
  });
});
