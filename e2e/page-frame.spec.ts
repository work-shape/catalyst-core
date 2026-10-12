import type { Locator, Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const admin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

/** `--layout-page-top` in a wide window: the room above a page's title line. */
const PAGE_TOP = 56;
/** `--layout-page-top` in a narrow window, under the band of the button that opens the sidebar. */
const PAGE_TOP_NARROW = 24;
/** `--layout-header`: that band, and the least height of a detail head. */
const HEADER = 64;
/** The title line is as high as a control. */
const TITLE_LINE = 36;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// Fails with the frame as it was after the top bar went: a list page's title line started
// 24 px under the window's edge, a detail head at the edge itself, and nothing named the area.
test("every page's title line starts under the frame's top room, and the area's name stands on it", async ({
  page
}) => {
  await page.setViewportSize(WIDE);
  const workspace = await signIn(page);
  const titleLineMiddle = PAGE_TOP + TITLE_LINE / 2;

  const lists: { path: string; title: string; area?: string }[] = [
    { path: "/build/agents", title: "Agents", area: "Build" },
    { path: "/build/skills", title: "Skills", area: "Build" },
    { path: "/settings/instance/users", title: "Users", area: "Settings" },
    { path: "/settings/you/profile", title: "Profile", area: "Settings" },
    { path: "/inbox", title: "Inbox" },
    { path: `/w/${workspace}/apps`, title: "Apps" }
  ];
  for (const { path, title, area } of lists) {
    await page.goto(path);
    const heading = page.getByRole("heading", { level: 1, name: title, exact: true });
    await expect(heading, path).toBeVisible();
    const head = page.locator('header[data-variant="list"]').filter({ has: heading });
    expect(await top(head), path).toBe(PAGE_TOP);
    expect(await middle(heading), path).toBe(titleLineMiddle);
    const areaName = page.locator("[data-subrail-title]");
    if (area === undefined) {
      await expect(areaName, path).toHaveCount(0);
    } else {
      await expect(areaName, path).toHaveText(area);
      expect(await middle(areaName), path).toBe(titleLineMiddle);
    }
  }
});

// Fails with top room over a pinned head: the head rested 42 px down and slid to the top edge
// with the first scroll, and the list of sections beside the content moved with it.
test("an editor's head is the top band from the start, and it and the section list stand still while the page scrolls", async ({
  page
}) => {
  await page.setViewportSize(WIDE);
  await signIn(page);
  await page.goto("/build/agents/research_assistant");
  const detail = page.locator('header[data-variant="detail"]');
  await expect(detail.getByRole("heading", { level: 1 })).toBeVisible();
  const back = detail.getByRole("button", { name: "Back to Agents" });
  const sections = page.getByRole("navigation", { name: "Sections of this page" });
  const field = page.getByLabel("Display name");

  expect(await top(detail)).toBe(0);
  expect(await middle(back)).toBe(HEADER / 2);
  const sectionsTop = await top(sections);
  expect(sectionsTop).toBeGreaterThanOrEqual(HEADER);
  const fieldTop = await top(field);

  await field.hover();
  await page.mouse.wheel(0, 300);
  // The content moved; the head and the section list did not.
  await expect.poll(() => top(field)).toBe(fieldTop - 300);
  expect(await top(detail)).toBe(0);
  expect(await middle(back)).toBe(HEADER / 2);
  expect(await top(sections)).toBe(sectionsTop);
});

test("in a narrow window the area's name stands beside the sidebar button, over the select of its pages", async ({
  page
}) => {
  await page.setViewportSize(PHONE);
  await signIn(page);

  for (const { path, title, area, pages } of [
    { path: "/build/agents", title: "Agents", area: "Build", pages: "Kinds in Build" },
    { path: "/settings/instance/users", title: "Users", area: "Settings", pages: "Settings pages" }
  ]) {
    await page.goto(path);
    const heading = page.getByRole("heading", { level: 1, name: title, exact: true });
    await expect(heading, path).toBeVisible();
    const sidebarButton = page.getByRole("button", { name: "Open sidebar" });
    const areaName = page.locator("[data-subrail-title]");
    await expect(areaName, path).toHaveText(area);
    // One band: the button and the name on its middle line, the name after the button.
    expect(await middle(areaName), path).toBe(HEADER / 2);
    expect(await middle(sidebarButton), path).toBe(HEADER / 2);
    const buttonBox = await box(sidebarButton);
    const nameText = await box(areaName.locator("span"));
    expect(nameText.x, path).toBeGreaterThan(buttonBox.x + buttonBox.width);
    // Under the band the select of the area's pages, then the page's own name.
    const select = page.getByRole("combobox", { name: pages });
    expect(await top(select), path).toBeGreaterThanOrEqual(HEADER);
    expect(await top(heading), path).toBeGreaterThan((await box(select)).y + 36);
  }

  // A page without a rail starts its title line a step under the band.
  await page.goto("/inbox");
  const inbox = page.getByRole("heading", { level: 1, name: "Inbox", exact: true });
  await expect(inbox).toBeVisible();
  const head = page.locator('header[data-variant="list"]').filter({ has: inbox });
  expect(await top(head)).toBe(HEADER + PAGE_TOP_NARROW);
});

async function signIn(page: Page): Promise<string> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: admin.email, password: admin.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  return /\/w\/([^/]+)$/u.exec(page.url())?.[1] ?? "";
}

async function box(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox();
  if (!found) {
    throw new Error("The element has no box");
  }
  return found;
}

async function top(locator: Locator): Promise<number> {
  return Math.round((await box(locator)).y);
}

/** The height of an element's middle line in the window. */
async function middle(locator: Locator): Promise<number> {
  const { y, height } = await box(locator);
  return Math.round(y + height / 2);
}
