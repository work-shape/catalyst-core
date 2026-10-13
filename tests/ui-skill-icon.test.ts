import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnowsHowTo, SkillIcon, UiRoot, uiLabelsEn } from "@vivd-catalyst/ui";
import { UiGallery } from "@vivd-catalyst/ui/gallery";

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

  it("is hidden from assistive technology and never sits on a tile", () => {
    for (const markup of [render({ icon: "pdf", size: "lg" }), render({ size: "sm" })]) {
      expect(markup).toMatch(/^<span aria-hidden="true"/u);
      expect(markup).not.toMatch(/\bbg-|rounded/u);
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
