import { createElement, Fragment, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CountBadge,
  docsAddress,
  DocsAddressProvider,
  DocsLink,
  ListRow,
  NavGroup,
  NavItem,
  Page,
  PageFooter,
  PageHeader,
  PageHeaderBack,
  PageOutline,
  type PageProps,
  SaveBar,
  type SaveBarProps,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  Sidebar,
  SkipLink,
  SubRail,
  type SubRailGroup,
  type SubRailProps,
  Tabs,
  TabsContent,
  TabsDisclosure,
  TabsLink,
  TabsList,
  TabsNav,
  TabsTrigger,
  UiRoot,
  uiLabelsDe,
  uiLabelsEn
} from "@work-shape/catalyst-ui";

function render(element: ReactElement, labels = uiLabelsEn): string {
  return renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels }, element));
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

  it("sets what stands at the end of a tab row outside the set of tabs", () => {
    const row = (open: boolean) =>
      render(
        createElement(
          Tabs,
          { defaultValue: "a" },
          createElement(
            TabsList,
            {
              label: "Views",
              end: createElement(TabsDisclosure, { open, onOpenChange() {} }, "Technical details")
            },
            createElement(TabsTrigger, { value: "a" }, "First")
          )
        )
      );

    const folded = row(false);
    const list = /<div[^>]*role="tablist"[^>]*>.*?<\/div>/u.exec(folded)?.[0] ?? "";
    expect(list).toContain("First");
    expect(list).not.toContain("Technical details");
    expect(folded.indexOf("Technical details")).toBeGreaterThan(folded.indexOf("First"));
    expect(folded).toMatch(
      /<button type="button" aria-expanded="false"[^>]*><span[^>]*>Technical details/u
    );
    expect(row(true)).toMatch(/aria-expanded="true"[^>]*><span[^>]*>Technical details/u);
    expect(folded).not.toMatch(/role="tab"[^>]*>Technical details/u);
  });

  it("reads a tab's count out with its noun, and shows it quiet unless it is told to stand out", () => {
    const tabs = (labels: typeof uiLabelsEn) =>
      renderToStaticMarkup(
        createElement(
          UiRoot,
          { mode: "light", labels },
          createElement(
            Tabs,
            { defaultValue: "a" },
            createElement(
              TabsList,
              { label: "Views" },
              createElement(TabsTrigger, { value: "a", count: 1, countTone: "primary" }, "First"),
              createElement(TabsTrigger, { value: "b", count: 120 }, "Second")
            )
          ),
          createElement(
            TabsNav,
            { label: "Routes" },
            createElement(TabsLink, { href: "/members", count: 3 }, "Members")
          )
        )
      );

    const english = tabs(uiLabelsEn);
    expect(english).toMatch(
      />First<span class="[^"]*bg-primary[^"]*" aria-hidden="true">1<\/span><span class="sr-only">, 1 item<\/span>/u
    );
    // The eye gets the capped number and the screen reader the whole one.
    expect(english).toMatch(
      />Second<span class="[^"]*bg-state-pressed[^"]*" aria-hidden="true">99\+<\/span><span class="sr-only">, 120 items<\/span>/u
    );
    expect(english).toMatch(/>Members<span[^>]*>3<\/span><span class="sr-only">, 3 items<\/span>/u);
    const german = tabs(uiLabelsDe);
    expect(german).toContain('<span class="sr-only">, 1 Eintrag</span>');
    expect(german).toContain('<span class="sr-only">, 120 Einträge</span>');
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

    // The line is drawn by the frame around the row that scrolls, so the row's edge fade
    // leaves it whole.
    for (const [markup, framePattern, rowPattern, tabPattern, selectedLine] of [
      [
        viewTabs,
        /<div class="([^"]*)"><div[^>]*role="tablist"/u,
        /<div[^>]*role="tablist"[^>]*class="([^"]*)"/u,
        /<button[^>]*role="tab"[^>]*class="([^"]*)"/u,
        "data-[state=active]:border-primary"
      ],
      [
        routeTabs,
        /<nav[^>]*class="([^"]*)"/u,
        /<nav[^>]*><div[^>]*class="([^"]*)"/u,
        /<a[^>]*class="([^"]*)"/u,
        "border-primary"
      ]
    ] as const) {
      const frameClasses = markup.match(framePattern)?.[1]?.split(" ");
      expect(frameClasses).toContain("shadow-[inset_0_-1px_0_var(--color-border)]");
      const rowClasses = markup.match(rowPattern)?.[1]?.replaceAll("&amp;", "&").split(" ");
      expect(rowClasses).toEqual(
        expect.arrayContaining([
          "overflow-x-auto",
          "overflow-y-hidden",
          "[scrollbar-width:none]",
          "[&::-webkit-scrollbar]:hidden"
        ])
      );
      expect(frameClasses).not.toContain("border-b");
      expect(frameClasses).not.toContain("pb-px");
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
    expect(markup).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>List<\/button>/u);
    expect(markup).not.toContain("tabular-nums");
  });

  it("shows a segment's count after its label, inside the radio", () => {
    const markup = render(
      createElement(
        SegmentedControl,
        { label: "View", value: "list" },
        createElement(SegmentedControlItem, { value: "list", count: 120 }, "List"),
        createElement(SegmentedControlItem, { value: "rights", count: 0 }, "Rights")
      )
    );

    expect(markup).toMatch(
      /role="radio"[^>]*>List<span[^>]*tabular-nums[^>]*>99\+<\/span><\/button>/u
    );
    expect(markup).toMatch(/role="radio"[^>]*>Rights<span[^>]*>0<\/span><\/button>/u);
  });

  it("shows a segment's whole count where the number is the fact the segment states", () => {
    const markup = render(
      createElement(
        SegmentedControl,
        { label: "Entries", value: "all" },
        createElement(
          SegmentedControlItem,
          { value: "failed", count: 3, exactCount: true },
          "Failed"
        ),
        createElement(SegmentedControlItem, { value: "all", count: 20000, exactCount: true }, "All")
      )
    );

    expect(markup).toMatch(/role="radio"[^>]*>Failed<span[^>]*tabular-nums[^>]*>3<\/span>/u);
    expect(markup).toMatch(/role="radio"[^>]*>All<span[^>]*tabular-nums[^>]*>20000<\/span>/u);
    expect(markup).not.toContain("99+");
    expect(render(createElement(CountBadge, { count: 600, exact: true }))).toContain(">600<");
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
        secondaryActions: [{ label: "SECOND", onSelect: () => undefined }],
        primaryAction: "PRIMARY",
        menu: "MENU"
      })
    );
    // The "…" menu's button stands last; the menu's items show only once it opens. What follows
    // the `inert` mark only measures the row and shows nothing.
    const shown = markup.slice(0, markup.indexOf("inert"));
    const order = [
      "BACK",
      "NAME",
      "SCOPE",
      "STATE",
      "SECOND",
      "PRIMARY",
      'aria-label="More actions"'
    ].map((slot) => shown.indexOf(slot));

    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(markup).toMatch(/<h1[^>]*>NAME<\/h1>/u);
  });

  it("puts the description of a detail head on the name's row and none under it", () => {
    const head = render(
      createElement(PageHeader, {
        variant: "detail",
        back: createElement(PageHeaderBack, { label: "WAY", href: "/agents", children: "BACK" }),
        title: "NAME",
        scope: "SCOPE",
        state: "STATE",
        description: "ABOUT",
        primaryAction: "PRIMARY"
      })
    );
    const order = ["BACK", "NAME", "SCOPE", "STATE", "ABOUT", "PRIMARY"].map((slot) =>
      head.indexOf(slot)
    );
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    // The way back is a link named without its text, which gives way to the name.
    expect(head).toMatch(
      /<a href="\/agents"[^>]*data-slot="page-header-back"[^>]*aria-label="WAY"/u
    );
    // The name gives way last: it takes a second line, is then cut and says itself whole on
    // hover. Unseen beside it, the name on one line keeps the row's least width.
    expect(head).toMatch(
      /<h1[^>]*class="[^"]*line-clamp-2[^"]*"[^>]*title="NAME"[^>]*>NAME<\/h1><span aria-hidden="true" data-name="NAME"/u
    );
    expect(head).toMatch(/data-slot="page-header-description"[^>]*>ABOUT</u);
    expect(head).toMatch(/shrink-\[1000000000000\][^>]*><div[^>]*data-slot="page-header-chips"/u);
    const list = render(createElement(PageHeader, { title: "NAME", description: "ABOUT" }));
    expect(list).not.toContain("page-header-description");
    expect(list).toMatch(/<\/h1><\/div><div[^>]*>ABOUT<\/div>/u);
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

    // Fails without `descriptionWraps`: a narrow row cut the line that says who and when.
    const wrapping = render(
      createElement(ListRow, { title: "Row", description: "WHEN WHO", descriptionWraps: true })
    );
    expect(wrapping).toMatch(/<span class="[^"]*sm:truncate[^"]*">WHEN WHO/u);
    expect(wrapping).not.toMatch(/<span class="truncate[^"]*">WHEN WHO/u);

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
    // Without the newer props nothing else is drawn: one button and no count.
    expect(inline.match(/<button/gu)).toHaveLength(1);
    expect(inline).not.toContain("data-save-bar-changes");
  });

  it("gives the save bar a change count and a discard button, and hides it while clean", () => {
    const bar = (props: Partial<SaveBarProps>) =>
      render(
        createElement(SaveBar, {
          label: "Save",
          changes: "3 changes",
          discardLabel: "Discard",
          onDiscard: () => undefined,
          ...props
        })
      );

    const dirty = bar({ whenClean: "hidden", dirty: true });
    expect(dirty).toMatch(/<span data-save-bar-changes=""[^>]*>3 changes<\/span>/u);
    // Discard never submits the form, and it stands after the save button.
    expect(dirty).toMatch(
      /<button[^>]*type="submit"[\s\S]*<button[^>]*type="button"[^>]*>Discard/u
    );
    expect(dirty).not.toMatch(/<button[^>]*disabled=""[^>]*>Discard/u);

    expect(bar({ whenClean: "hidden", dirty: false })).toBe(render(createElement(Fragment)));
    expect(bar({ whenClean: "hidden" })).not.toContain("data-mode");
    // A save under way keeps the bar, and holds discard.
    expect(bar({ whenClean: "hidden", saving: true })).toMatch(
      /<button[^>]*disabled=""[^>]*>Discard/u
    );
    // The default keeps the bar while clean, and a label without a handler draws no button.
    expect(bar({ dirty: false })).toContain("3 changes");
    expect(bar({ onDiscard: undefined })).not.toContain("Discard");
  });
});

describe("the space a page ends with", () => {
  const rail = () =>
    createElement(SubRail, {
      label: "Pages",
      value: "a",
      onValueChange: () => undefined,
      groups: [{ id: "g", items: [{ id: "a", label: "A" }] }]
    });
  const head = () => createElement(PageHeader, { variant: "detail", title: "HEAD" });
  const outline = () => createElement(PageOutline, { items: [{ id: "a", label: "A" }] });

  it("is the page-end token on the content column of every layout, and nowhere else", () => {
    // Fails with the three `pb-6` the layouts carried: no layout named the token.
    const layouts = [
      createElement(Page, null, "BODY"),
      createElement(Page, { subRail: rail() }, "BODY"),
      createElement(Page, { header: head() }, "BODY"),
      createElement(Page, { header: head(), subRail: rail() }, "BODY"),
      createElement(Page, { outline: outline() }, "BODY"),
      createElement(Page, { header: head(), outline: outline() }, "BODY")
    ];
    for (const layout of layouts) {
      const markup = render(layout);
      expect(markup.match(/pb-\(--layout-page-end\)/gu)).toHaveLength(1);
      // The token is on the element that holds the content, so a rail's row does not end early.
      expect(markup).toMatch(/class="[^"]*pb-\(--layout-page-end\)[^"]*">BODY</u);
      expect(markup).not.toMatch(/\bpb-6\b/u);
    }
  });

  it("is above a footer that stays at the lower edge", () => {
    const classes = render(createElement(PageFooter, null, "SAVE"))
      .match(/data-page-footer="" class="([^"]*)"/u)?.[1]
      ?.split(" ");
    expect(classes).toEqual(
      expect.arrayContaining([
        "sticky",
        "bottom-0",
        "mt-(--layout-page-end)",
        "-mb-(--layout-page-end)"
      ])
    );
  });

  // Fails without the variant: a footer with a notice of several lines stayed at the lower
  // edge of a phone and stood over the fields the notice is about.
  it("rests at the end of the page on a phone where it is pinned for wide windows only", () => {
    const classes = render(createElement(PageFooter, { pinned: "wide" }, "NOTICE"))
      .match(/data-page-footer="" class="([^"]*)"/u)?.[1]
      ?.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["sm:sticky", "sm:bottom-0"]));
    expect(classes).not.toContain("sticky");
    expect(classes).not.toContain("bottom-0");
  });

  it("is enclosed by one line only: a section before the footer draws none", () => {
    // Fails without the rule: the section's line and the footer's line enclosed the end space.
    const markup = render(createElement(Section, { title: "LAST" }, "FIELDS"));
    expect(markup).toMatch(/<section[^>]*class="[^"]*has-\[\+\[data-page-footer\]\]:border-b-0/u);
  });
});

describe("a page with a head across its width", () => {
  it("puts the head above the rail and the content, outside their gutter", () => {
    // Fails without the `header` slot: the head sat in the content column, inside the page's
    // gutter and beside the rail, so its ends did not meet the edges of what is under it.
    const markup = render(
      createElement(
        Page,
        {
          header: createElement(PageHeader, { variant: "detail", title: "HEAD" }),
          subRail: createElement(SubRail, {
            belowHeader: true,
            label: "Pages",
            value: "a",
            onValueChange: () => undefined,
            groups: [{ id: "g", items: [{ id: "a", label: "A" }] }]
          })
        },
        "BODY"
      )
    );
    const head = markup.indexOf("HEAD");
    const rail = markup.indexOf('data-sub-rail=""');
    expect(head).toBeGreaterThan(-1);
    expect(head).toBeLessThan(rail);
    expect(rail).toBeLessThan(markup.indexOf("BODY"));
    // The page itself brings no gutter: the head and the row under it each bring their own.
    expect(markup).toMatch(/^<div[^>]*><div class="@container\/page w-full min-w-0">/u);
  });

  it("keeps the select of a sub-rail pinned", () => {
    const markup = render(
      createElement(SubRail, {
        label: "Pages",
        value: "a",
        onValueChange: () => undefined,
        groups: [{ id: "g", items: [{ id: "a", label: "A" }] }]
      })
    );
    expect(markup).toMatch(/data-sub-rail="" class="[^"]*\bsticky\b/u);
  });

  it("links into the documentation from the instance's docs address, in a new tab", () => {
    const link = createElement(DocsLink, {
      path: "/operate/how-rights-work/#building-and-using",
      accessibleName: "Learn more about workspaces, opens in a new tab",
      children: "Learn more"
    });
    const at = (address: string | undefined) =>
      render(createElement(DocsAddressProvider, { address, children: link }));

    const markup = at("https://docs.workshape.ai/catalyst");
    expect(markup).toMatch(
      /<a href="https:\/\/docs\.workshape\.ai\/catalyst\/operate\/how-rights-work\/#building-and-using" target="_blank" rel="noopener noreferrer" aria-label="Learn more about workspaces, opens in a new tab"/u
    );
    // It takes the colour of the text it stands in, is underlined and ends with the mark.
    const classes = /<a [^>]*class="([^"]*)"/u.exec(markup)?.[1]?.split(" ") ?? [];
    expect(classes).toEqual(expect.arrayContaining(["text-inherit", "underline"]));
    expect(markup).toMatch(/>Learn more<svg[^>]*aria-hidden="true"/u);
    // The docs address keeps its own path, with or without a slash at its end.
    expect(at("https://docs.workshape.ai/catalyst/")).toContain(
      'href="https://docs.workshape.ai/catalyst/operate/how-rights-work/#building-and-using"'
    );
    expect(docsAddress("https://docs.example.com", "operate/x/")).toBe(
      "https://docs.example.com/operate/x/"
    );
  });

  it("renders no documentation link on an instance without a docs address", () => {
    const link = createElement(DocsLink, {
      path: "/operate/how-rights-work/",
      accessibleName: "Learn more, opens in a new tab",
      children: "Learn more"
    });

    expect(render(createElement("p", null, "A sentence.", link))).toBe(
      render(createElement("p", null, "A sentence."))
    );
    expect(
      render(createElement(DocsAddressProvider, { address: undefined, children: link }))
    ).not.toContain("<a");
    expect(docsAddress(undefined, "/operate/")).toBeUndefined();
    expect(docsAddress("", "/operate/")).toBeUndefined();
  });
});

/** Whether a value of `Candidate` may be handed where `Props` are asked for. */
type Fits<Candidate, Props> = [Candidate] extends [Props] ? true : false;

describe("a sub-rail only opens pages", () => {
  it("refuses, by its types, to scroll within a page or to share a page with an outline", () => {
    // Each line fails the type check of the tests once the library accepts what it names.
    // What the editors handed a sub-rail that followed the scroll: no open route.
    const sectionsOnly: Fits<{ label: string; groups: SubRailGroup[] }, SubRailProps> = false;
    const hasMode: Fits<"mode", keyof SubRailProps> = false;
    // The left column navigates, the right outline scrolls: a page has one of them.
    const both: Fits<{ subRail: ReactElement; outline: ReactElement }, PageProps> = false;
    const railOnly: Fits<{ subRail: ReactElement }, PageProps> = true;
    const outlineOnly: Fits<{ outline: ReactElement }, PageProps> = true;
    expect([sectionsOnly, hasMode, both, railOnly, outlineOnly]).toEqual([
      false,
      false,
      false,
      true,
      true
    ]);

    const rail = render(
      createElement(SubRail, {
        label: "Pages",
        value: "a",
        onValueChange: () => undefined,
        groups: [{ id: "g", items: [{ id: "a", label: "A" }] }]
      })
    );
    expect(rail).not.toContain('href="#');
    expect(rail).not.toContain('aria-current="location"');
  });
});
