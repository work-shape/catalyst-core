import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STARTER_ICON_NAMES } from "@work-shape/catalyst-asset-schemas";
import {
  IconPicker,
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

  it("gives an icon the hue of its family, one hue per family", () => {
    const hueOf = (name: string) =>
      /bg-tint-([a-z]+)\/12 text-tint-\1/u.exec(icon({ icon: name }))?.[1];
    const hues = starterIconFamilies.map(({ names }) => [...new Set(names.map(hueOf))]);

    expect(hues).toEqual([["blue"], ["green"], ["amber"], ["violet"], ["teal"], ["rose"]]);
  });

  it("shows the speech bubble on the neutral tile without an icon and for a name nobody draws", () => {
    for (const markup of [icon({}), icon({ icon: "rocket" })]) {
      expect(markup).toContain('data-starter-icon="default"');
      expect(markup).toContain("lucide-message-square-text");
      expect(markup).toContain("bg-secondary");
      expect(markup).not.toContain("tint-");
      expect(markup).toMatch(/^<span aria-hidden="true"/u);
    }
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

  it("shows nine whole, and the first nine of a longer list with a button for the rest", () => {
    expect(list(9, { show: "More", hide: "Fewer" })).toContain("Title 9");
    expect(list(9, { show: "More", hide: "Fewer" })).not.toContain("More");
    const markup = list(12, { show: "More", hide: "Fewer" });

    expect(markup).toContain("Title 9");
    expect(markup).not.toContain("Title 10");
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>More<\/button>/u);
  });

  it("shows a long list whole where the caller gives no words for the fold", () => {
    expect(list(12)).toContain("Title 12");
  });
});

describe("IconPicker", () => {
  it("names its button by what it belongs to and what is chosen, and shows that icon", () => {
    const picker = (value?: string) =>
      render(
        createElement(IconPicker, {
          label: "Icon of prompt 1",
          groups: [
            {
              label: "Planning",
              options: [
                {
                  name: "calendar",
                  label: "Calendar",
                  icon: createElement(StarterIcon, { icon: "calendar", size: "sm" })
                }
              ]
            }
          ],
          value,
          defaultIcon: createElement(StarterIcon, { size: "sm" }),
          defaultLabel: "Default",
          onChange: () => undefined
        })
      );

    expect(picker()).toContain('aria-label="Icon of prompt 1: Default"');
    expect(picker()).toContain('data-starter-icon="default"');
    expect(picker("calendar")).toContain('aria-label="Icon of prompt 1: Calendar"');
    expect(picker("calendar")).toContain('data-starter-icon="calendar"');
    // A name the picker does not offer shows as the default.
    expect(picker("rocket")).toContain('aria-label="Icon of prompt 1: Default"');
  });
});
