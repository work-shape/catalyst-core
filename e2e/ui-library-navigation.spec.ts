import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type Locator, type Page } from "@playwright/test";

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

test("the sidebar is 280 px wide, collapses to icons and is a drawer under 768 px", async ({
  page
}) => {
  const root = await openGallery(page, "Navigation");
  const entry = root.locator('[data-gallery-entry="Sidebar"]');
  const sidebar = entry.locator("aside");

  expect((await sidebar.boundingBox())?.width).toBe(280);
  expect(await style(sidebar.locator("nav"), "padding-left")).toBe("8px");
  // No rule between the header, the list and the footer.
  const innerRules = await sidebar.evaluate((element) =>
    Array.from(element.children).map((child) => {
      const computed = getComputedStyle(child);
      return computed.borderTopWidth + computed.borderBottomWidth;
    })
  );
  expect(new Set(innerRules)).toEqual(new Set(["0px0px"]));

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
