import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CountBadge,
  ListRow,
  NavGroup,
  NavItem,
  PageHeader,
  SaveBar,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  Sidebar,
  SkipLink,
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

  it("keeps both tab rows scrolling sideways without scrollbars, the underline on the edge of the row's line", () => {
    const viewTabs = render(
      createElement(
        Tabs,
        { defaultValue: "a" },
        createElement(
          TabsList,
          { label: "Views" },
          createElement(TabsTrigger, { value: "a" }, "First")
        )
      )
    );
    const routeTabs = render(
      createElement(
        TabsNav,
        { label: "Workspace" },
        createElement(TabsLink, { selected: true, href: "/general" }, "General")
      )
    );

    for (const [markup, rowPattern, tabPattern, selectedLine] of [
      [
        viewTabs,
        /<div[^>]*role="tablist"[^>]*class="([^"]*)"/u,
        /<button[^>]*role="tab"[^>]*class="([^"]*)"/u,
        "data-[state=active]:border-primary"
      ],
      [routeTabs, /<nav[^>]*class="([^"]*)"/u, /<a[^>]*class="([^"]*)"/u, "border-primary"]
    ] as const) {
      const rowClasses = markup.match(rowPattern)?.[1]?.replaceAll("&amp;", "&").split(" ");
      expect(rowClasses).toEqual(
        expect.arrayContaining([
          "overflow-x-auto",
          "overflow-y-hidden",
          "[scrollbar-width:none]",
          "[&::-webkit-scrollbar]:hidden",
          "shadow-[inset_0_-1px_0_var(--color-border)]"
        ])
      );
      // The row has no border and no padding under the tabs, and no tab is pulled out of
      // it: the underline of the selected tab ends on the edge the row's line ends on.
      expect(rowClasses).not.toContain("border-b");
      expect(rowClasses).not.toContain("pb-px");
      expect(markup.match(tabPattern)?.[1]?.split(" ")).not.toContain("-mb-px");
      const tabClasses = markup.match(tabPattern)?.[1]?.split(" ");
      expect(tabClasses).toEqual(
        expect.arrayContaining([
          "border-b-2",
          selectedLine,
          "focus-visible:outline-2",
          "focus-visible:-outline-offset-2",
          "focus-visible:outline-ring"
        ])
      );
    }
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

  it("keeps a navigation item's marks and actions beside it, out of the button", () => {
    const markup = render(
      createElement(
        NavItem,
        { trailing: createElement("button", { "aria-label": "More" }), className: "mt-1" },
        "Offer"
      )
    );

    // The row carries the fill and the caller's class; the item and the slot are siblings.
    expect(markup).toMatch(/<div class="group\/nav-item[^"]*hover:bg-state-hover[^"]*mt-1"/u);
    expect(markup).toMatch(/<button[^>]*>.*?Offer<\/span><\/button><span[^>]*opacity-0/u);
    expect(markup).toContain("group-focus-within/nav-item:opacity-100");
    expect(markup).toContain("pointer-coarse:opacity-100");
  });

  it("makes the sidebar one named navigation landmark and collapses its items to icons", () => {
    const items = [
      createElement(NavItem, { key: "a", icon: createElement("svg") }, "New chat"),
      createElement(NavItem, { key: "b", trailing: "x" }, "No icon")
    ];
    const open = render(createElement(Sidebar, { label: "Main navigation" }, items));
    expect(open).toMatch(/<nav aria-label="Main navigation"[^>]*w-\(--layout-sidebar\)/u);
    expect(open.match(/<nav/gu)).toHaveLength(1);
    expect(open).toContain("No icon");

    const collapsed = render(
      createElement(Sidebar, { label: "Main navigation", collapsed: true }, items)
    );
    expect(collapsed).toContain("w-(--layout-sidebar-collapsed)");
    expect(collapsed).toContain('<span class="sr-only">New chat</span>');
    // An item without an icon has nothing to show in the strip.
    expect(collapsed).not.toContain("No icon");

    // Fails without the count on the collapsed item: it showed a dot that named no number.
    const counted = render(
      createElement(
        Sidebar,
        { label: "Main navigation", collapsed: true },
        createElement(NavItem, { icon: createElement("svg"), count: 7 }, "Inbox")
      )
    );
    expect(counted).toMatch(/absolute -top-0\.5 -right-0\.5[^>]*>7<\/span>/u);
  });

  it("pins a group's label in the scrolling body of a sidebar, and nowhere else", () => {
    const group = createElement(
      NavGroup,
      { key: "g", label: "Recent" },
      createElement(NavItem, null, "Lease")
    );
    const folding = createElement(
      NavGroup,
      { key: "f", label: "Folding", collapsible: true },
      createElement(NavItem, null, "Offer")
    );
    const pinned = [
      "sticky",
      "top-0",
      "z-(--layer-sticky-header)",
      "-mt-2",
      "h-9",
      "bg-sidebar",
      "pt-2",
      // The fade under it, in the sidebar's colour, shown only on the label marked as pinned
      // over items.
      "after:absolute",
      "after:inset-x-0",
      "after:top-full",
      "after:h-3",
      "after:bg-linear-to-b",
      "after:from-sidebar",
      "after:to-transparent",
      "after:pointer-events-none",
      "after:opacity-0",
      "data-pinned-fade:after:opacity-100"
    ];
    const labelClasses = (markup: string) =>
      Array.from(markup.matchAll(/data-nav-group-label="" class="([^"]*)"/gu), (match) =>
        (match[1] ?? "").split(" ")
      );

    const inSidebar = render(
      createElement(Sidebar, { label: "Main navigation" }, [group, folding])
    );
    const sidebarLabels = labelClasses(inSidebar);
    expect(sidebarLabels).toHaveLength(2);
    // At rest no label is marked: the fade would lie over the first item.
    expect(inSidebar).not.toContain("data-pinned-fade=");
    for (const classes of sidebarLabels) {
      expect(classes).toEqual(expect.arrayContaining(pinned));
      // The label's own height gives way to the one that holds the room above it.
      expect(classes).not.toContain("h-7");
    }
    // The room above the first group belongs to what scrolls, so the label lies over it.
    const bodyClasses = inSidebar.match(/data-sidebar-body="" class="([^"]*)"/u)?.[1]?.split(" ");
    expect(bodyClasses).not.toContain("pt-2");
    expect(bodyClasses).not.toContain("p-2");
    expect(inSidebar).toMatch(/data-sidebar-body=""[^>]*><div class="flex flex-col gap-4 pt-2">/u);

    // Outside a sidebar a label is on a surface it does not know, and stays where it is.
    const alone = labelClasses(render(createElement("div", null, [group, folding])));
    expect(alone).toHaveLength(2);
    for (const classes of alone) {
      expect(classes).toContain("h-7");
      expect(classes).not.toContain("sticky");
      expect(classes).not.toContain("bg-sidebar");
    }
  });

  it("ends the sidebar's scrolling body with a line above the footer, and draws none without one", () => {
    const item = createElement(NavItem, { key: "a" }, "Lease");
    const withFooter = render(
      createElement(Sidebar, { label: "Main navigation", footer: "Account" }, item)
    );
    const footerClasses = withFooter
      .match(/<div data-sidebar-footer="" class="([^"]*)">Account<\/div>/u)?.[1]
      ?.split(" ");
    expect(footerClasses).toEqual(
      expect.arrayContaining(["shrink-0", "border-t", "border-sidebar-border", "p-2"])
    );
    // The body grows, so the footer and its line stay at the bottom under a short list, and
    // the last item scrolls a group's distance clear of the line.
    const bodyClasses = withFooter.match(/data-sidebar-body="" class="([^"]*)"/u)?.[1]?.split(" ");
    expect(bodyClasses).toEqual(
      expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto", "pb-4"])
    );

    const withoutFooter = render(createElement(Sidebar, { label: "Main navigation" }, item));
    expect(withoutFooter).not.toContain("data-sidebar-footer");
    expect(withoutFooter).not.toContain("border-t");
  });

  it("links past the navigation without changing the address by itself", () => {
    const markup = render(
      createElement(SkipLink, { target: "content", children: "Skip to content" })
    );

    expect(markup).toMatch(/<a href="#content" class="sr-only focus-visible:not-sr-only/u);
    expect(markup).toContain("Skip to content");
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

    // Fails without `descriptionLeading`: the status line had no place for the person's mark.
    const person = render(
      createElement(ListRow, {
        title: "Row",
        description: "Ada via Agent",
        descriptionLeading: "AV"
      })
    );
    expect(person.indexOf("AV")).toBeGreaterThan(person.indexOf("Row"));
    expect(person.indexOf("AV")).toBeLessThan(person.indexOf("Ada via Agent"));

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
