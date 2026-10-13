import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Breadcrumb, IconTile, UiRoot, uiLabelsEn } from "@vivd-catalyst/ui";

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element)
  );
}

// The way into a nested place, and the tile an icon stands in. Both fail without the
// components: the library had neither, and a feature would have styled its own.
describe("Breadcrumb", () => {
  const way = (items: Parameters<typeof Breadcrumb>[0]["items"]) =>
    render(createElement(Breadcrumb, { label: "Way", items }));

  it("is a named navigation whose last place is the current one and leads nowhere", () => {
    const markup = way([
      { id: "a", label: "Quarter close", onSelect: () => undefined },
      { id: "b", label: "Send reminders" }
    ]);
    expect(markup).toMatch(/<nav aria-label="Way" data-slot="breadcrumb"/u);
    expect(markup).toMatch(/<button type="button"[^>]*>Quarter close<\/button>/u);
    expect(markup).toMatch(/<span aria-current="page"[^>]*>Send reminders<\/span>/u);
    expect(markup.match(/aria-current/gu)).toHaveLength(1);
  });

  it("makes a place with an address a link, so it opens in a new tab like any other", () => {
    const markup = way([
      { id: "a", label: "Run", href: "/w/1/workflows/a/runs/r", onSelect: () => undefined },
      { id: "b", label: "This run" }
    ]);
    expect(markup).toMatch(/<a href="\/w\/1\/workflows\/a\/runs\/r"[^>]*>Run<\/a>/u);
    expect(markup).not.toContain("<button");
  });

  it("marks a single place as the current one, with no separator", () => {
    const markup = way([{ id: "a", label: "Only" }]);
    expect(markup).toMatch(/aria-current="page"[^>]*>Only</u);
    expect(markup).not.toContain("<svg");
  });
});

describe("IconTile", () => {
  it("takes the accent only where it is asked to, and one of two sizes", () => {
    const plain = render(createElement(IconTile, null, "i"));
    const accent = render(createElement(IconTile, { accent: true, size: "lg" }, "i"));
    expect(plain).toMatch(/data-slot="icon-tile" class="[^"]*bg-secondary[^"]*size-7/u);
    expect(accent).toMatch(/class="[^"]*bg-primary-soft[^"]*size-9/u);
    expect(accent).not.toMatch(/class="[^"]*bg-secondary/u);
  });
});
