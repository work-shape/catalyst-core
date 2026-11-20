import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STARTER_ICON_NAMES } from "@work-shape/catalyst-asset-schemas";
import {
  IconPicker,
  SkillIcon,
  Starter,
  StarterList,
  UiRoot,
  genericIcons,
  starterIconNames,
  uiLabelsEn
} from "@work-shape/catalyst-ui";

const render = (node: ReactElement) =>
  renderToStaticMarkup(createElement(UiRoot, { labels: uiLabelsEn, mode: "light" }, node));

describe("starter icons", () => {
  it("draws every icon an agent may store, and offers no other", () => {
    expect([...starterIconNames].sort()).toEqual([...STARTER_ICON_NAMES].sort());
    for (const name of STARTER_ICON_NAMES) {
      expect(genericIcons[name], name).toBeDefined();
    }
  });

  it("stands a chosen icon on the tile in ink, like the icon of an author's request", () => {
    const markup = renderToStaticMarkup(createElement(SkillIcon, { icon: "calendar", size: "lg" }));

    expect(markup).toContain('data-skill-icon="calendar"');
    expect(markup).toContain("data-skill-icon-tile");
    expect(markup).toContain("text-foreground");
  });
});

describe("StarterList", () => {
  const list = (count: number, more?: { show: string; hide: string }) =>
    render(
      createElement(StarterList, {
        label: "Suggestions",
        more,
        children: Array.from({ length: count }, (_, index) =>
          createElement(Starter, {
            key: index,
            title: `Title ${index + 1}`,
            hint: `Hint ${index + 1}`
          })
        )
      })
    );

  it("keeps up to four as roomy cards with their hints", () => {
    const markup = list(4, { show: "More", hide: "Fewer" });

    expect(markup).toContain('data-starters="roomy"');
    expect(markup).toContain("Hint 4");
    expect(markup).not.toContain("More");
  });

  it("stands more than four as short cards without hints, in two columns and three when wide", () => {
    const markup = list(6, { show: "More", hide: "Fewer" });

    expect(markup).toContain('data-starters="compact"');
    expect(markup).toContain("grid-cols-2");
    expect(markup).toContain("@[40rem]/starters:grid-cols-3");
    expect(markup).not.toContain("Hint 1");
    expect(markup).toContain("Title 6");
    expect(markup).not.toContain("More");
  });

  it("shows the first six of a longer list and a button for the rest", () => {
    const markup = list(9, { show: "More", hide: "Fewer" });

    expect(markup).toContain("Title 6");
    expect(markup).not.toContain("Title 7");
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>More<\/button>/u);
  });

  it("shows a long list whole where the caller gives no words for the fold", () => {
    expect(list(9)).toContain("Title 9");
  });
});

describe("IconPicker", () => {
  it("names its button by what it belongs to and what is chosen, and shows that icon", () => {
    const picker = (value?: string) =>
      render(
        createElement(IconPicker, {
          label: "Icon of prompt 1",
          options: [{ name: "calendar", label: "Calendar" }],
          value,
          defaultIcon: "prompt",
          defaultLabel: "Default",
          onChange: () => undefined
        })
      );

    expect(picker()).toContain('aria-label="Icon of prompt 1: Default"');
    expect(picker()).toContain("lucide-message-square-text");
    expect(picker("calendar")).toContain('aria-label="Icon of prompt 1: Calendar"');
    expect(picker("calendar")).toContain("lucide-calendar");
    // A name the picker does not offer shows as the default.
    expect(picker("rocket")).toContain('aria-label="Icon of prompt 1: Default"');
  });
});
