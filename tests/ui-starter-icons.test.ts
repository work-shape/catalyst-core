import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STARTER_ICON_NAMES } from "@work-shape/catalyst-asset-schemas";
import {
  Starter,
  StarterIcon,
  StarterList,
  UiRoot,
  starterIconFamilies,
  starterIconNames,
  uiLabelsEn
} from "@work-shape/catalyst-ui";

const render = (node: ReactElement) =>
  renderToStaticMarkup(createElement(UiRoot, { labels: uiLabelsEn, mode: "light" }, node));

describe("starter icons", () => {
  const icon = (props: Parameters<typeof StarterIcon>[0]) =>
    renderToStaticMarkup(createElement(StarterIcon, props));

  it("draws every icon an agent may store, and offers no other", () => {
    expect([...starterIconNames].sort()).toEqual([...STARTER_ICON_NAMES].sort());
    expect(starterIconFamilies.flatMap(({ names }) => names)).toEqual(starterIconNames);
    for (const name of STARTER_ICON_NAMES) {
      expect(icon({ icon: name }), name).toContain(`data-starter-icon="${name}"`);
    }
  });

  it("shows the default for a name nobody draws", () => {
    expect(icon({ icon: "rocket" })).toContain('data-starter-icon="default"');
  });
});

describe("StarterList", () => {
  const list = (count: number, more?: { show: string; hide: string }) =>
    render(
      createElement(StarterList, {
        label: "Suggestions",
        more,
        children: Array.from({ length: count }, (_, index) =>
          createElement(Starter, { key: index, title: `Title ${index + 1}` })
        )
      })
    );

  it("shows nine whole, and the first nine of a longer list with a button for the rest", () => {
    expect(list(9, { show: "More", hide: "Fewer" })).not.toContain("More");
    const markup = list(12, { show: "More", hide: "Fewer" });

    expect(markup).toContain("Title 9");
    expect(markup).not.toContain("Title 10");
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>More<\/button>/u);
    // Without words for the fold the list shows whole.
    expect(list(12)).toContain("Title 12");
  });
});
