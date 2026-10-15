import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Page,
  PageHeader,
  PageLead,
  PageOutline,
  SubRail,
  UiRoot,
  uiLabelsEn
} from "@work-shape/catalyst-ui";

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element)
  );
}

describe("the room above a page's title line", () => {
  const rail = (title?: string) =>
    createElement(SubRail, {
      title,
      label: "Pages",
      value: "a",
      onValueChange: () => undefined,
      groups: [{ id: "g", items: [{ id: "a", label: "A" }] }]
    });

  // Fails with the padding the layouts carried: six steps of spacing over a list page, so its
  // name stood near the window's edge.
  it("is the page-top token where the head scrolls with the page, and nothing over a pinned head", () => {
    const head = createElement(PageHeader, { variant: "detail", title: "HEAD" });
    const plain = render(createElement(Page, null, "BODY"));
    expect(plain).toMatch(
      /class="[^"]*pt-\[calc\(var\(--layout-page-inset\)\+var\(--layout-page-top\)\)\][^"]*">BODY</u
    );
    const beside = render(createElement(Page, { subRail: rail() }, "BODY"));
    expect(beside).toContain(
      "@subrail/page:pt-[calc(var(--layout-page-inset)+var(--layout-page-top))]"
    );
    // The rail is pinned one step higher than its first line, for its focus ring.
    expect(beside).toContain(
      "@subrail/page:top-[calc(var(--layout-page-inset)+var(--layout-page-top)-var(--spacing))]"
    );
    // Fails with room over a detail head: the head is pinned, so it rested lower than it stays
    // and slid to the top edge with the first scroll, and the rail under it with it.
    for (const headed of [
      render(createElement(Page, { header: head }, "BODY")),
      render(
        createElement(
          Page,
          {
            header: head,
            outline: createElement(PageOutline, {
              belowHeader: true,
              items: [{ id: "a", label: "A" }]
            })
          },
          "BODY"
        )
      )
    ]) {
      expect(headed).not.toContain("--layout-page-top");
      expect(headed).toContain(
        'class="h-[var(--layout-page-head-inset,var(--layout-page-inset))]"'
      );
    }
    for (const markup of [plain, beside]) {
      expect(markup).not.toMatch(/var\(--spacing\)\*6/u);
    }
  });

  it("heads a rail with the area's name on a line as high as the title line, and as no heading", () => {
    const markup = render(createElement(Page, { subRail: rail("AREA") }, "BODY"));
    const title = markup.match(/<p data-subrail-title="" class="([^"]*)"[^>]*><span[^>]*>AREA</u);
    expect(title?.[1]?.split(" ")).toEqual(
      expect.arrayContaining(["text-title-lg", "@subrail/page:h-9", "h-(--subrail-title)"])
    );
    // The name comes before the select and the links it heads.
    expect(markup.indexOf("AREA")).toBeLessThan(markup.indexOf("<select"));
    expect(markup).not.toMatch(/<h[1-6][^>]*>(?:<span[^>]*>)?AREA/u);
    // Above the content the name stands in the band of a floating control, after that control.
    expect(title?.[1]).toContain("ps-(--layout-page-head-start)");
    expect(markup).toMatch(/data-sub-rail="" class="[^"]*-mt-\(--layout-page-inset\)/u);
  });

  it("gives a rail without a name the same room over its select", () => {
    const markup = render(createElement(Page, { subRail: rail() }, "BODY"));
    expect(markup).not.toContain("data-subrail-title");
    expect(markup).toMatch(
      /data-sub-rail="" class="[^"]*pt-\[max\(var\(--spacing\)\*2,var\(--subrail-room\)\)\]/u
    );
  });
});

describe("the lead paragraph of a page", () => {
  it("keeps to two lines and offers no control before a text is known to be longer", () => {
    const markup = render(createElement(PageLead, null, "What the page is about."));
    expect(markup).toMatch(/<p[^>]*class="[^"]*line-clamp-2[^"]*">What the page is about\.<\/p>/u);
    expect(markup).toContain("text-muted-foreground");
    expect(markup).not.toContain("<button");
  });
});
