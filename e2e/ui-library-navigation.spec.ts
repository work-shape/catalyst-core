import { requestWithOrigin } from "./request-with-origin";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

test("tabs and the segmented control follow the keyboard, and route tabs are links", async ({
  page
}) => {
  const root = await openGallery(page, "Navigation");

  const tabs = root.locator('[data-gallery-entry="Tabs"]');
  const tabList = tabs.getByRole("tablist");
  await tabList.getByRole("tab", { name: "General" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabList.getByRole("tab", { name: /Members/u })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(tabs.getByRole("tabpanel")).toContainText("Twelve people");
  // The disabled tab is passed over, so End lands on the last tab that can be opened.
  await page.keyboard.press("End");
  await expect(tabList.getByRole("tab", { name: /Requests/u })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.keyboard.press("Home");
  await expect(tabList.getByRole("tab", { name: "General" })).toBeFocused();

  const routeTabs = tabs.locator('[data-gallery-sample="tabs-routes"]');
  await expect(routeTabs.getByRole("tab")).toHaveCount(0);
  const requests = routeTabs.getByRole("link", { name: /Requests/u });
  await requests.click();
  await expect(requests).toHaveAttribute("aria-current", "page");
  await expect(routeTabs.locator("[aria-current]")).toHaveCount(1);

  const segmented = root
    .locator('[data-gallery-entry="SegmentedControl"]')
    .getByRole("radiogroup")
    .first();
  const users = segmented.getByRole("radio", { name: "Users" });
  const permissions = segmented.getByRole("radio", { name: "Permissions" });
  await expect(users).toBeChecked();
  await users.focus();
  // The choice follows the focus while the arrow key is held, so the key is released after it.
  await page.keyboard.down("ArrowRight");
  await expect(permissions).toBeFocused();
  await page.keyboard.up("ArrowRight");
  await expect(permissions).toBeChecked();
  await page.keyboard.down("ArrowLeft");
  await expect(users).toBeFocused();
  await page.keyboard.up("ArrowLeft");
  await expect(users).toBeChecked();
});

// Fails with a border under the row: the row clips at its padding edge, so the underline of
// the selected tab then ended one pixel above the bottom edge of the row's line.
test("a tab row does not scroll vertically, and the selected tab's underline ends on the edge of the row's line", async ({
  page
}) => {
  const root = await openGallery(page, "Navigation");
  const tabs = root.locator('[data-gallery-entry="Tabs"]');
  const rows = [
    {
      row: tabs.getByRole("tablist"),
      selected: tabs.getByRole("tablist").locator('[role="tab"][aria-selected="true"]')
    },
    {
      row: tabs.locator('[data-gallery-sample="tabs-routes"]').getByRole("navigation"),
      selected: tabs.locator('[data-gallery-sample="tabs-routes"] [aria-current="page"]')
    }
  ];
  for (const { row, selected } of rows) {
    const rowBox = await row.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        bottom: box.bottom,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        offsetHeight: element instanceof HTMLElement ? element.offsetHeight : 0
      };
    });
    const selectedBox = await selected.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        bottom: element.getBoundingClientRect().bottom,
        underline: style.borderBottomWidth
      };
    });
    expect(rowBox.scrollHeight).toBe(rowBox.clientHeight);
    // Nothing of the row lies under what it clips: no border the underline cannot reach.
    expect(rowBox.offsetHeight).toBe(rowBox.clientHeight);
    expect(selectedBox.underline).toBe("2px");
    expect(selectedBox.bottom).toBe(rowBox.bottom);
  }
});

test("navigation items, list rows, sections and the save bar keep their measures", async ({
  page
}) => {
  const root = await openGallery(page, "Navigation");

  const navItems = root.locator('[data-gallery-entry="NavItem"]');
  const resting = navItems.getByRole("button", { name: "Chat" });
  const selected = navItems.getByRole("button", { name: "Apps" });
  expect((await resting.boundingBox())?.height).toBe(32);
  expect(await style(resting, "font-weight")).toBe("400");
  expect(await style(resting, "border-radius")).toBe("8px");
  expect(await style(selected, "font-weight")).toBe("500");
  expect(await style(selected, "border-left-width")).toBe("0px");
  expect(await style(selected, "background-color")).not.toBe(
    await style(resting, "background-color")
  );
  const groupLabel = navItems.getByRole("group").first().locator("span").first();
  expect(await style(groupLabel, "font-size")).toBe("12px");
  expect(await style(groupLabel, "font-weight")).toBe("500");
  expect(await style(groupLabel, "text-transform")).toBe("none");

  await openSection(page, "Data");
  const rows = root.locator('[data-gallery-entry="ListRow"] li');
  const heights = await rows.evaluateAll((elements) =>
    elements.map((element) => element.firstElementChild?.getBoundingClientRect().height ?? 0)
  );
  expect(heights).toContain(44);
  expect(heights).toContain(36);
  expect(await style(rows.first(), "box-shadow")).toBe("none");

  // A table has no outer box and no header fill; its heads are caption text at weight 500.
  const table = root.locator('[data-gallery-entry="Table"] table').first();
  const head = table.locator("th").first();
  expect(await style(table, "border-top-width")).toBe("0px");
  expect(await style(table.locator("xpath=.."), "border-top-width")).toBe("0px");
  expect(await style(table.locator("thead tr"), "background-color")).toBe("rgba(0, 0, 0, 0)");
  expect(await style(head, "font-size")).toBe("12px");
  expect(await style(head, "font-weight")).toBe("500");
  expect(await style(head, "text-transform")).toBe("none");

  await openSection(page, "Page structure");
  const section = root.locator('[data-gallery-entry="Section"] section').first();
  expect(await style(section, "box-shadow")).toBe("none");
  expect(await style(section, "border-top-width")).toBe("0px");
  expect(await style(section, "border-bottom-width")).toBe("1px");
  expect(await style(section, "background-color")).toBe("rgba(0, 0, 0, 0)");
  // A detail header's rule runs to both edges of its frame.
  const detail = root.locator('[data-gallery-entry="PageHeader"] header').last();
  const frame = detail.locator("xpath=..");
  expect((await detail.boundingBox())?.width).toBe(
    await frame.evaluate((element) => element.clientWidth)
  );

  await openSection(page, "Forms");
  const stickyBar = root.locator('[data-gallery-sample="save-bar-sticky"] [data-mode="sticky"]');
  expect(await style(stickyBar, "position")).toBe("sticky");
  expect(await style(stickyBar, "box-shadow")).not.toBe("none");
  const inlineBar = root.locator('[data-gallery-entry="SaveBar"] [data-mode="inline"]').first();
  expect(await style(inlineBar, "box-shadow")).toBe("none");

  await openSection(page, "Status");
  expect(await root.locator('[data-gallery-entry="CountBadge"]').innerText()).toContain("99+");
});

// Fails without the pinned label: it scrolled away with the items, and an item cut in half
// stood against the row above the list.
test("a group's label stays at the top of a sidebar's body while its items scroll under it", async ({
  page
}) => {
  const root = await openGallery(page, "Navigation");
  const sample = root.locator('[data-gallery-sample="nav-group-pinned-label"]');
  const body = sample.locator("[data-sidebar-body]");
  const label = sample.locator("[data-nav-group-label]");
  const measure = () =>
    body.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const pinned = element.querySelector("[data-nav-group-label]");
      const labelBox = pinned?.getBoundingClientRect();
      // What shows at the top edge of the body, and just under the label.
      const at = (y: number) =>
        document.elementFromPoint(element.getBoundingClientRect().left + 40, y);
      return {
        labelTop: (labelBox?.top ?? 0) - top,
        labelHeight: labelBox?.height,
        labelAtTopEdge: at(top + 1) === pinned,
        labelAboveItems: at((labelBox?.bottom ?? 0) - 1) === pinned,
        fade: pinned ? getComputedStyle(pinned, "::after").opacity : undefined,
        fadeHeight: pinned ? getComputedStyle(pinned, "::after").height : undefined,
        fadeImage: pinned ? getComputedStyle(pinned, "::after").backgroundImage : undefined,
        mask: getComputedStyle(element).maskImage
      };
    });

  await expect(label).toHaveText("Label that stays while its items scroll");
  await sample.scrollIntoViewIfNeeded();
  const resting = await measure();
  // At rest the label fades nothing: its fade would lie over the first item.
  expect(resting).toMatchObject({
    labelTop: 0,
    labelHeight: 36,
    labelAtTopEdge: true,
    fade: "0"
  });
  expect(await style(label, "padding-top")).toBe("8px");
  expect(await style(label, "position")).toBe("sticky");
  expect(await style(label, "background-color")).toBe(
    await style(sample.locator("nav"), "background-color")
  );

  await body.evaluate((element) => {
    element.scrollTop = 100;
  });
  // The body's mask and the label's fade follow the scroll a moment later, each on its own:
  // both are waited for, and the rest is read once they stand.
  await expect.poll(async () => (await measure()).mask).toContain("linear-gradient");
  // The label carries the fade of the start: 12 px of the sidebar's colour under it.
  await expect
    .poll(async () => {
      const { fade, fadeHeight } = await measure();
      return { fade, fadeHeight };
    })
    .toEqual({ fade: "1", fadeHeight: "12px" });
  const scrolled = await measure();
  expect(scrolled).toMatchObject({
    labelTop: 0,
    labelHeight: 36,
    labelAtTopEdge: true,
    labelAboveItems: true,
    fade: "1",
    fadeHeight: "12px"
  });
  // The body fades its end and not its start: a fade there would take the label with it.
  expect(scrolled.mask).not.toContain("transparent 0");
  expect(scrolled.fadeImage).toContain("linear-gradient");

  // Back at the start the label is still at the top, and its fade is gone again.
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(async () => (await measure()).fade).toBe("0");
  await expect(label).toBeInViewport();
});

test("the sidebar is 280 px wide, collapses to icons and is a drawer under 768 px", async ({
  page
}) => {
  const root = await openGallery(page, "Navigation");
  const entry = root.locator('[data-gallery-entry="Sidebar"]');
  const sidebar = entry.locator("nav").first();

  expect((await sidebar.boundingBox())?.width).toBe(280);
  expect(await style(sidebar.locator("[data-sidebar-body]"), "padding-left")).toBe("8px");
  // One rule, above the footer: without it the last item of the list read as part of the
  // footer. It has the colour of the sidebar's own edge, and the list ends a group's distance
  // before it when scrolled to its end.
  const innerRules = await sidebar.evaluate((element) =>
    Array.from(element.children).map((child) => {
      const computed = getComputedStyle(child);
      return {
        footer: child.hasAttribute("data-sidebar-footer"),
        top: computed.borderTopWidth,
        bottom: computed.borderBottomWidth,
        sameColourAsEdge: computed.borderTopColor === getComputedStyle(element).borderRightColor
      };
    })
  );
  expect(innerRules.map(({ footer, top, bottom }) => ({ footer, top, bottom }))).toEqual([
    { footer: false, top: "0px", bottom: "0px" },
    { footer: false, top: "0px", bottom: "0px" },
    { footer: true, top: "1px", bottom: "0px" }
  ]);
  expect(innerRules.at(-1)?.sameColourAsEdge).toBe(true);
  expect(await style(sidebar.locator("[data-sidebar-body]"), "padding-bottom")).toBe("16px");
  const footerBox = await sidebar.locator("[data-sidebar-footer]").boundingBox();
  const sidebarBox = await sidebar.boundingBox();
  expect((footerBox?.y ?? 0) + (footerBox?.height ?? 0)).toBe(
    (sidebarBox?.y ?? 0) + (sidebarBox?.height ?? 0)
  );

  await entry.getByRole("button", { name: "Collapse sidebar" }).click();
  expect((await sidebar.boundingBox())?.width).toBe(48);
  await expect(sidebar.getByRole("link", { name: "Apps" })).toBeVisible();
  await expect(sidebar.getByText("Recent")).toHaveCount(0);
  await entry.getByRole("button", { name: "Expand sidebar" }).click();
  expect((await sidebar.boundingBox())?.width).toBe(280);

  await page.setViewportSize({ width: 700, height: 800 });
  await expect(sidebar).toBeHidden();
  await entry.getByRole("button", { name: "Open navigation" }).click();
  const drawer = entry.getByRole("dialog");
  await expect(drawer).toBeVisible();
  expect((await drawer.boundingBox())?.width).toBe(280);
  await expect(drawer.getByRole("link", { name: "Apps" })).toBeVisible();
  // Escape closes it, and so does a press outside.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await entry.getByRole("button", { name: "Open navigation" }).click();
  await page.mouse.click(600, 400);
  await expect(drawer).toBeHidden();
  await entry.getByRole("button", { name: "Open navigation" }).click();
  await drawer.getByRole("link", { name: "Workflows" }).click();
  await expect(drawer).toBeHidden();
});

test("a drawer holds the focus, closes on Escape and on the backdrop, and gives the focus back", async ({
  page
}) => {
  const root = await openGallery(page, "Overlays");
  const entry = root.locator('[data-gallery-entry="Drawer"]');
  const opener = entry.getByRole("button", { name: "Open drawer", exact: true });
  const drawer = root.getByRole("dialog", { name: "Edit agent" });

  // It opens at the right edge at the window's full height, with the focus on its close button.
  await opener.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Close" })).toBeFocused();
  const viewport = page.viewportSize();
  const box = await drawer.boundingBox();
  expect(box?.width).toBe(448);
  expect(box?.height).toBe(viewport?.height);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBe(viewport?.width);
  // It is the raised surface a dialog is.
  expect(await style(drawer, "--popover")).toBe(await style(root, "--popover"));
  expect(await style(drawer, "border-radius")).toBe("0px");

  // Tab goes through the drawer's own controls and never reaches the page behind it.
  const reached = new Set<string>();
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press("Tab");
    const focused = await drawer.evaluate((element) => {
      const active = document.activeElement;
      return {
        inside: active !== null && element.contains(active),
        onPage: active !== null && active !== document.body && !element.contains(active),
        name: active?.textContent?.trim() ?? ""
      };
    });
    expect(focused.onPage).toBe(false);
    if (focused.inside) {
      reached.add(focused.name);
    }
  }
  expect([...reached]).toEqual(expect.arrayContaining(["Cancel", "Save", "Delete agent"]));

  // The body scrolls between the header and the footer, which stay in place.
  const save = drawer.getByRole("button", { name: "Save", exact: true });
  const heading = drawer.getByRole("heading", { name: "Edit agent" });
  const remove = drawer.getByRole("button", { name: "Delete agent" });
  const headingTop = (await heading.boundingBox())?.y;
  const saveTop = (await save.boundingBox())?.y;
  await remove.scrollIntoViewIfNeeded();
  expect((await heading.boundingBox())?.y).toBe(headingTop);
  expect((await save.boundingBox())?.y).toBe(saveTop);

  // A confirmation opened inside it takes the first Escape, the drawer the second.
  await remove.click();
  const confirmation = drawer.getByRole("dialog", { name: "Delete Support assistant?" });
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();

  // A press on the backdrop closes it too, and the left one stands at the left edge.
  await opener.click();
  await expect(drawer).toBeVisible();
  await page.mouse.click(40, 300);
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
  await entry.getByRole("button", { name: "Open drawer on the left" }).click();
  await expect(drawer).toBeVisible();
  expect((await drawer.boundingBox())?.x).toBe(0);
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();

  // At 390 px it covers the window.
  await page.setViewportSize({ width: 390, height: 800 });
  await opener.click();
  await expect(drawer).toBeVisible();
  expect(await drawer.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 800 });
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("the sub-rail navigates routes, scrolls to anchors and follows the scroll", async ({
  page
}) => {
  const root = await openGallery(page, "Navigation");
  const routes = root.locator('[data-gallery-sample="subrail-routes"]');
  const anchors = root.locator('[data-gallery-sample="subrail-anchors"]');
  const openRoute = routes.locator('[data-gallery-sample="subrail-route"]');

  // While its page keeps 40rem for the content beside it, it is a rail of links.
  const routeSelect = routes.getByRole("combobox", { name: "Settings pages" });
  await expect(routeSelect).toBeHidden();
  const rail = routes.getByRole("navigation");
  expect((await rail.boundingBox())?.width).toBe(224);
  await rail.getByRole("link", { name: "Security" }).click();
  await expect(openRoute).toHaveText("Security");
  await expect(rail.getByRole("link", { name: "Security" })).toHaveAttribute(
    "aria-current",
    "page"
  );

  const anchorRail = anchors.getByRole("navigation");
  await anchorRail.getByRole("link", { name: /Skills/u }).click();
  await expect(anchorRail.locator("[aria-current]")).toHaveText(/Skills/u);
  await expect
    .poll(() => offsetInFrame(anchors, anchors.getByRole("heading", { name: "Skills" })))
    .toBeLessThan(80);
  await anchors.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(anchorRail.locator("[aria-current]")).toHaveText(/Overview/u);
  await anchors.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(anchorRail.locator("[aria-current]")).toHaveText(/History/u);

  // With less room in the page it is the library's native select.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(rail).toBeHidden();
  await expect(routeSelect).toBeVisible();
  expect(await routeSelect.evaluate((element) => element.tagName)).toBe("SELECT");
  await routeSelect.selectOption({ label: "Members (3)" });
  await expect(openRoute).toHaveText("Members");

  const anchorSelect = anchors.getByRole("combobox", { name: "Sections of this page" });
  await anchorSelect.selectOption({ label: "Instructions" });
  await expect
    .poll(() => offsetInFrame(anchors, anchors.getByRole("heading", { name: "Instructions" })))
    .toBeLessThan(120);
  await anchors.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect.poll(() => selectedLabel(anchorSelect)).toBe("History");
  await anchors.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect.poll(() => selectedLabel(anchorSelect)).toBe("Overview");
});

const gallerySections = [
  "Foundations",
  "Actions",
  "Forms",
  "Overlays",
  "Navigation",
  "Page structure",
  "Data",
  "Status",
  "Feedback"
];

test("no section of the gallery scrolls sideways at 390 px, and a wide table says where it goes on", async ({
  page
}) => {
  await openGallery(page, "Data");
  for (const section of gallerySections) {
    // The section rail is a row of buttons only in a wide window.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSection(page, section);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect.poll(() => widerThanItsBox(page), section).toEqual([]);
  }

  // A table wider than its box scrolls inside the box and shades the side that hides columns.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSection(page, "Data");
  await page.setViewportSize({ width: 390, height: 800 });
  const table = page.locator('[data-gallery-sample="table-data"]');
  const box = table.locator("xpath=..");
  const frame = box.locator("xpath=..");
  await box.scrollIntoViewIfNeeded();
  await expect(frame.locator('[data-slot="table-edge-shade"][data-side="end"]')).toBeVisible();
  await expect(frame.locator('[data-slot="table-edge-shade"][data-side="start"]')).toHaveCount(0);
  await box.evaluate((element) => element.scrollTo({ left: 60 }));
  await expect(frame.locator('[data-slot="table-edge-shade"][data-side="start"]')).toBeVisible();

  // A cut cell holds its whole value, and shows it to the keyboard and to a press.
  const cut = table.locator("tbody tr").first().locator('[data-slot="table-cell-value"]').last();
  const whole = "Found in the monthly check and not yet looked at by anyone in the team.";
  await expect(cut).toHaveText(whole);
  await cut.focus();
  await expect(page.getByRole("tooltip", { name: whole })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await cut.click();
  await expect(page.getByRole("tooltip", { name: whole })).toBeVisible();
});

/** The section and every box around it that is wider inside than it shows, by tag and class. */
function widerThanItsBox(page: Page): Promise<string[]> {
  return page.locator("[data-gallery-section]").evaluate((section) => {
    const wider: string[] = [];
    for (let box: Element | null = section; box; box = box.parentElement) {
      if (box.scrollWidth > box.clientWidth + 1) {
        wider.push(`${box.tagName.toLowerCase()}.${box.className}`);
      }
    }
    return wider;
  });
}

async function openGallery(page: Page, section: string): Promise<Locator> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: adminUser.email, password: adminUser.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/ui-library");
  await openSection(page, section);
  const root = page.locator("[data-gallery-mode]").first();
  await expect(root).toBeVisible();
  return root;
}

/** Opens one section of the gallery by its entry in the section rail. */
async function openSection(page: Page, name: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Sections of the UI library" })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.locator("[data-gallery-section] h2").first()).toHaveText(name);
}

function style(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property
  );
}

/** How far below the top of its scrolling frame an element stands. */
async function offsetInFrame(frame: Locator, element: Locator): Promise<number> {
  const frameBox = await frame.boundingBox();
  const elementBox = await element.boundingBox();
  if (!frameBox || !elementBox) {
    return Number.POSITIVE_INFINITY;
  }
  return elementBox.y - frameBox.y;
}

function selectedLabel(select: Locator): Promise<string> {
  return select.evaluate((element) =>
    element instanceof HTMLSelectElement ? (element.selectedOptions[0]?.label ?? "") : ""
  );
}
