import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { ALLOWED_URL, plantConnection, removeConnection } from "./connection-fixtures";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { z } from "zod";
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
    { path: "/build/agents", title: "Agents", area: "Studio" },
    { path: "/build/skills", title: "Skills", area: "Studio" },
    { path: "/settings/instance/users", title: "Users", area: "Settings" },
    { path: "/settings/you/profile", title: "Profile", area: "Settings" },
    { path: "/inbox", title: "Inbox" },
    { path: `/w/${workspace}/agents`, title: "Agents" },
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
  const sections = page.getByRole("navigation", { name: "On this page" });
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
    { path: "/build/agents", title: "Agents", area: "Studio", pages: "Kinds in Studio" },
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

/** A name longer than any head has room for beside its actions. */
const LONG_TITLE =
  "Monthly check of every booking against the ledger and the open items of the quarter before it";

// Fails with the head of two lines: under the name stood the kind and the technical id, and a
// long name or many actions wrapped the head to a second and third row.
test("the head of every asset page is one row as high as the header, and the id stands once in the first section", async ({
  page
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize(WIDE);
  await signIn(page);

  const run = randomUUID().slice(0, 8);
  const skill = `e2e_frame_${run}`;
  const skillUrl = `${apiBaseUrl}/api/v1/assets/skill/${skill}`;
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `frame-business-${run}`,
    displayName: LONG_TITLE,
    url: ALLOWED_URL,
    authScheme: "none" as const
  };
  const app = `frame-${run}`;

  const written = await requestWithOrigin(page, "put", skillUrl, {
    data: {
      expectedRevision: await assetBaseRevision(page, skillUrl),
      config: { name: skill, title: LONG_TITLE, description: "A probe.", content: "Text." }
    }
  });
  expect(written.ok(), await written.text()).toBe(true);
  await plantConnection(connection);
  try {
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name: `Frame ${run}` }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;
    const appUrl = `${apiBaseUrl}/api/v1/assets/app/${app}`;
    const saved = await requestWithOrigin(page, "put", appUrl, {
      data: {
        workspaceId,
        expectedRevision: null,
        files: [
          {
            path: "app.yaml",
            text: `id: ${app}\nname: ${LONG_TITLE}\nkit: 1.2.0\nentry: index.html\n`
          },
          { path: "index.html", text: "<!doctype html><html><body><h1>Frame</h1></body></html>" }
        ]
      },
      timeout: 90_000
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const published = await requestWithOrigin(page, "post", `${appUrl}/publish`, {
      data: { workspaceId, revision: 1 }
    });
    expect(published.ok(), await published.text()).toBe(true);

    const editors: { path: string; id?: string; wideOnly?: boolean }[] = [
      { path: "/build/agents/research_assistant", id: "research_assistant" },
      { path: `/build/skills/${skill}`, id: skill },
      { path: `/build/connections/${connection.name}`, id: connection.name },
      { path: `/w/${workspaceId}/apps/${app}` },
      // At 768 px the conversation of a draft covers the draft and its head.
      { path: `/w/${workspaceId}/apps/${app}/edit`, wideOnly: true }
    ];
    for (const size of [WIDE, { width: 768, height: 900 }]) {
      await page.setViewportSize(size);
      for (const { path, id, wideOnly } of editors) {
        if (wideOnly && size !== WIDE) {
          continue;
        }
        const where = `${path} at ${size.width}`;
        await page.goto(path);
        const head = page.locator('header[data-variant="detail"]');
        const name = head.getByRole("heading", { level: 1 });
        await expect(name, where).toBeVisible();
        const headBox = await box(head);
        expect(Math.round(headBox.y), where).toBe(0);
        expect(Math.round(headBox.height), where).toBe(HEADER);
        // One row: the name and every button of the head stand on its middle line.
        expect(await middle(name), where).toBe(HEADER / 2);
        for (const button of await head.getByRole("button").all()) {
          expect(await middle(button), where).toBe(HEADER / 2);
        }
        if (id !== undefined) {
          await expect(head, where).not.toContainText(id);
          const shown = page.locator("[data-asset-identifier]");
          await expect(shown, where).toHaveCount(1);
          await expect(shown.locator("code"), where).toHaveText(id);
          await expect(shown.getByRole("button", { name: "Copy" }), where).toBeVisible();
          await expect(
            page.locator("section").first().locator("[data-asset-identifier]")
          ).toHaveCount(1);
        }
      }
    }

    // A name that does not fit is cut and says itself whole in a tooltip.
    await page.goto(`/build/skills/${skill}`);
    const cut = page.locator('header[data-variant="detail"]').getByRole("heading", { level: 1 });
    await expect(cut).toHaveAttribute("title", LONG_TITLE);
    expect(await cut.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  } finally {
    await removeConnection(connection.id);
    await requestWithOrigin(page, "post", `${skillUrl}/delete`, {
      data: { expectedRevision: await assetRevision(page, skillUrl) }
    });
  }
});

// Fails with a head that cut the name first: at 390 px a run was named "Ru…" beside its chip
// and the text of its way back.
test("a narrowing head gives the chips, then the text of the way back, and cuts the name last", async ({
  page
}) => {
  await page.setViewportSize(WIDE);
  await signIn(page);
  const run = randomUUID().slice(0, 8);
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `frame-narrow-${run}`,
    displayName: "Ledger of the quarter",
    url: ALLOWED_URL,
    authScheme: "none" as const
  };
  await plantConnection(connection);
  try {
    await page.goto(`/build/connections/${connection.name}`);
    const head = page.locator('header[data-variant="detail"]');
    const name = head.getByRole("heading", { level: 1 });
    await expect(name).toBeVisible();
    const read = () =>
      head.evaluate(async (element) => {
        // The head measures its row after a resize and draws again.
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const title = element.querySelector("h1");
        const back = element.querySelector("[data-slot=page-header-back]");
        const text = element.querySelector("[data-slot=page-header-back-text]");
        const chips = element.querySelector("[data-slot=page-header-chips]");
        if (!title || !back || !text || !chips) {
          throw new Error("The head misses a part.");
        }
        const firstLine = chips.getBoundingClientRect().bottom;
        return {
          cut: title.scrollWidth > title.clientWidth,
          text: text.getBoundingClientRect().width > 0,
          chips: [...chips.children].filter(
            (chip) => chip.getBoundingClientRect().top < firstLine - 1
          ).length,
          // No gap is left where the text was: the name follows the way back at one distance.
          gap: Math.round(title.getBoundingClientRect().left - back.getBoundingClientRect().right)
        };
      });
    const wide = await read();
    expect(wide).toEqual({ cut: false, text: true, chips: 2, gap: wide.gap });
    const seen = [wide];
    for (let width = 760; width >= 240; width -= 20) {
      await page.setViewportSize({ width, height: 800 });
      seen.push(await read());
    }
    for (const [index, now] of seen.entries()) {
      const before = seen[Math.max(0, index - 1)] ?? now;
      const where = `step ${index}: ${JSON.stringify(now)}`;
      expect(now.gap, where).toBe(wide.gap);
      expect(now.chips, where).toBeLessThanOrEqual(before.chips);
      // The text stays while a chip could still go, and the name is whole while the text shows.
      expect(now.text && before.text === false, where).toBe(false);
      expect(now.text && now.cut, where).toBe(false);
      expect(!now.text && now.chips > 0, where).toBe(false);
    }
    // Each part went, and the arrow stood alone beside the whole name before the name was cut.
    expect(seen.some((now) => now.text && now.chips === 0)).toBe(true);
    expect(seen.some((now) => !now.text && !now.cut)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ cut: true, text: false, chips: 0 });
  } finally {
    await removeConnection(connection.id);
  }
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
