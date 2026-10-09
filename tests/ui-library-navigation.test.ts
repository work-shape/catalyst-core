import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CountBadge,
  ListRow,
  NavItem,
  PageHeader,
  SaveBar,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  SubRail,
  Tabs,
  TabsContent,
  TabsLink,
  TabsList,
  TabsNav,
  TabsTrigger,
  UiRoot,
  uiLabelsEn
} from "@vivd-catalyst/ui";

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element)
  );
}

const link = (href: string, label?: string) => createElement("a", { href }, label);

describe("navigation, page structure and data components", () => {
  it("caps a count at 99+", () => {
    expect(render(createElement(CountBadge, { count: 99 }))).toContain(">99<");
    expect(render(createElement(CountBadge, { count: 100 }))).toContain(">99+<");
  });

  it("gives view tabs the tab roles and a name", () => {
    const markup = render(
      createElement(
        Tabs,
        { defaultValue: "a" },
        createElement(
          TabsList,
          { label: "Views" },
          createElement(TabsTrigger, { value: "a" }, "First"),
          createElement(TabsTrigger, { value: "b", count: 3 }, "Second")
        ),
        createElement(TabsContent, { value: "a" }, "Body")
      )
    );

    expect(markup).toMatch(/role="tablist"[^>]*aria-label="Views"/u);
    expect(markup.match(/role="tab"/gu)).toHaveLength(2);
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"/u);
    expect(markup).toContain('role="tabpanel"');
  });

  it("renders route tabs as the caller's links and marks the open page", () => {
    const markup = render(
      createElement(
        TabsNav,
        { label: "Workspace" },
        createElement(TabsLink, { asChild: true, selected: true }, link("/general", "General")),
        createElement(TabsLink, { asChild: true, count: 3 }, link("/members", "Members"))
      )
    );

    expect(markup).toMatch(/<nav[^>]*aria-label="Workspace"/u);
    expect(markup).toMatch(/<a[^>]*href="\/general"[^>]*aria-current="page"/u);
    expect(markup).toMatch(/<a[^>]*href="\/members"/u);
    expect(markup.match(/aria-current/gu)).toHaveLength(1);
    expect(markup).not.toContain('role="tab"');
  });

  it("makes a segmented control a named radio group", () => {
    const markup = render(
      createElement(
        SegmentedControl,
        { label: "View", value: "list" },
        createElement(SegmentedControlItem, { value: "list" }, "List"),
        createElement(SegmentedControlItem, { value: "rights" }, "Rights")
      )
    );

    expect(markup).toMatch(/role="radiogroup"[^>]*aria-label="View"/u);
    expect(markup.match(/role="radio"/gu)).toHaveLength(2);
    expect(markup.match(/aria-checked="true"/gu)).toHaveLength(1);
  });

  it("renders a navigation item as a 32 px button or as the caller's link", () => {
    const button = render(createElement(NavItem, { selected: true, count: 120 }, "Inbox"));
    expect(button).toMatch(/<button[^>]*class="[^"]*\bh-8\b[^"]*bg-state-selected font-medium/u);
    expect(button).toContain(">99+<");
    expect(button).not.toMatch(/border-l|before:/u);

    const anchor = render(createElement(NavItem, { asChild: true }, link("/apps", "Apps")));
    expect(anchor).toMatch(/<a[^>]*href="\/apps"/u);
    expect(anchor).not.toContain("<button");
    expect(anchor).not.toContain("font-medium");
  });

  it("offers a sub-rail's entries as a select and as links", () => {
    const markup = render(
      createElement(SubRail, {
        mode: "routes",
        label: "Settings",
        value: "members",
        onValueChange: () => undefined,
        groups: [
          {
            id: "workspace",
            label: "Workspace",
            items: [
              { id: "general", label: "General", link: link("/general") },
              { id: "members", label: "Members", count: 3, link: link("/members") }
            ]
          }
        ]
      })
    );

    expect(markup).toMatch(/<select[^>]*aria-label="Settings"/u);
    expect(markup).toMatch(/<optgroup label="Workspace">/u);
    expect(markup).toMatch(/<option value="members" selected="">Members \(3\)<\/option>/u);
    expect(markup).toMatch(/<a[^>]*href="\/members"[^>]*aria-current="page"/u);
  });

  it("keeps the header's slots in one order", () => {
    const markup = render(
      createElement(PageHeader, {
        variant: "detail",
        title: "NAME",
        back: "BACK",
        scope: "SCOPE",
        state: "STATE",
        secondaryActions: "SECOND",
        primaryAction: "PRIMARY",
        overflow: "OVERFLOW"
      })
    );
    const order = ["BACK", "NAME", "SCOPE", "STATE", "SECOND", "PRIMARY", "OVERFLOW"].map((slot) =>
      markup.indexOf(slot)
    );

    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(markup).toMatch(/<h1[^>]*>NAME<\/h1>/u);
  });

  it("keeps a section flat and gives it its anchor, count and action", () => {
    const markup = render(
      createElement(
        Section,
        { id: "skills", title: "Skills", count: 4, action: "ADD", layout: "stacked" },
        "Body"
      )
    );

    expect(markup).toMatch(/<section[^>]*id="skills"/u);
    const sectionTag = /<section[^>]*>/u.exec(markup)?.[0] ?? "";
    expect(sectionTag).toMatch(/\bborder-b\b/u);
    expect(sectionTag).not.toMatch(/shadow|bg-|rounded|border(?!-b)/u);
    expect(markup).toContain(">4<");
    expect(markup).toContain("ADD");
  });

  it("renders a list row by its interaction mode and size", () => {
    const plain = render(createElement(ListRow, { title: "Row" }));
    expect(plain).toMatch(/<li/u);
    expect(plain).toContain("min-h-11");
    expect(plain).not.toMatch(/<button|<a /u);

    const linked = render(
      createElement(ListRow, { title: "Row", size: "compact", link: link("/row"), actions: "ACT" })
    );
    expect(linked).toMatch(/<a[^>]*href="\/row"[^>]*class="[^"]*min-h-9/u);
    // The action stands beside the link, not inside it.
    expect(linked.indexOf("ACT")).toBeGreaterThan(linked.indexOf("</a>"));

    const pressed = render(
      createElement(ListRow, { title: "Row", selected: true, onClick: () => undefined })
    );
    expect(pressed).toMatch(/<button[^>]*aria-current="true"/u);

    const unfolding = render(
      createElement(ListRow, { title: "Row", expandable: true, defaultExpanded: true }, "MORE")
    );
    expect(unfolding).toMatch(/<button[^>]*aria-expanded="true"/u);
    expect(unfolding).toContain("MORE");
  });

  it("gives the save bar a second action, and the raised shadow only when it is sticky", () => {
    const inline = render(createElement(SaveBar, { label: "Save", secondaryAction: "DISCARD" }));
    expect(inline).toMatch(/<button[^>]*type="submit"/u);
    expect(inline).toContain("DISCARD");
    expect(inline).not.toContain("shadow-raised");

    const sticky = render(
      createElement(SaveBar, { label: "Save", mode: "sticky", saved: true, savedLabel: "Saved" })
    );
    expect(sticky).toMatch(/class="[^"]*\bsticky\b[^"]*shadow-raised/u);
    expect(sticky).toMatch(/role="status"[^>]*>.*Saved/u);
  });
});
