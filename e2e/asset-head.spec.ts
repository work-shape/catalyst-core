import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The head of an asset and its row in a list (UXA-1a): the name, then what the asset does,
// never its id, which "Copy ID" in the head's menu offers. A long name takes a second line, is
// then cut and reads whole on hover: beside the dock at 1280 and at 390. Fails with the heads
// as they were: the name was cut on its one line, an App's card showed its id to a builder,
// and a Studio page showed the id in its first section.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const shotsDir = process.env.E2E_SHOTS_DIR;
const admin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const idSchema = z.object({ id: z.string() });

/** Sixty characters: longer than a row or a head beside the dock has room for on one line. */
const NAME = "Quarterly reconciliation of every open booking in the ledger";
const WHAT = "Checks every booking against the ledger before the quarter closes.";

/**
 * The name shows on at most two lines and stays in its box, and what the pointer rests on says
 * it whole: the name itself, or the card's target that lies over it.
 */
async function expectNameFits(name: Locator, hover: Locator, where: string): Promise<void> {
  await expect(name, where).toBeVisible();
  await expect(hover, where).toHaveAttribute("title", NAME);
  const shown = await name.evaluate((element) => ({
    lines: Math.round(
      element.clientHeight / Number.parseFloat(getComputedStyle(element).lineHeight)
    ),
    wide: element.scrollWidth > element.clientWidth
  }));
  expect(shown.lines, where).toBeGreaterThanOrEqual(1);
  expect(shown.lines, where).toBeLessThanOrEqual(2);
  expect(shown.wide, where).toBe(false);
}

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
}

test("a sixty-character name wraps, is then cut and reads whole, beside the dock and at 390, and the id is behind Copy ID", async ({
  page,
  context
}) => {
  test.setTimeout(180_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await page.goto("/");

  const run = randomUUID().slice(0, 8);
  const skill = `e2e_head_${run}`;
  const skillUrl = `${apiBaseUrl}/api/v1/assets/skill/${skill}`;
  const written = await requestWithOrigin(page, "put", skillUrl, {
    data: {
      expectedRevision: await assetBaseRevision(page, skillUrl),
      config: { name: skill, title: NAME, summary: WHAT, description: "A probe.", content: "Text." }
    }
  });
  expect(written.ok(), await written.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Head ${run}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const app = `head-${run}`;
  const appUrl = `${apiBaseUrl}/api/v1/assets/app/${app}`;
  const saved = await requestWithOrigin(page, "put", appUrl, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        {
          path: "app.yaml",
          text: `id: ${app}\nname: ${NAME}\ndescription: ${WHAT}\nkit: 1.2.0\nentry: index.html\n`
        },
        { path: "index.html", text: "<!doctype html><html><body><h1>Head</h1></body></html>" }
      ]
    },
    timeout: 90_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const published = await requestWithOrigin(page, "post", `${appUrl}/publish`, {
    data: { workspaceId, revision: 1 }
  });
  expect(published.ok(), await published.text()).toBe(true);
  const docked = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations`, {
    data: { title: "Beside the page" }
  });
  expect(docked.ok(), await docked.text()).toBe(true);
  const dock = idSchema.parse(await docked.json()).id;

  try {
    for (const [width, docks] of [
      [1280, true],
      [390, false]
    ] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      const look = `${width}${docks ? "-dock" : ""}`;
      const at = (path: string) => (docks ? `${path}?chat=${dock}` : path);
      const docked = async () => {
        if (docks) {
          await expect(page.locator("[data-dock-chat]")).toHaveAttribute("data-chat-mode", "dock");
        }
      };

      // The row in Studio: the name on two lines at most, what the skill does under it.
      await page.goto(at("/build/skills"));
      await docked();
      const row = page.getByRole("listitem").filter({ has: page.getByTitle(NAME) });
      await expectNameFits(row.getByTitle(NAME), row.getByTitle(NAME), `skills row at ${look}`);
      await expect(row).toContainText(WHAT);
      await expect(row).not.toContainText(skill);
      await shoot(page, `skills-list-${look}`);

      // The head of the skill: one row as high as the header, the name on two lines at most.
      await page.goto(at(`/build/skills/${skill}`));
      await docked();
      const head = page.locator('header[data-variant="detail"]');
      const name = head.getByRole("heading", { level: 1 });
      await expectNameFits(name, name, `skill head at ${look}`);
      await expect(page.locator("[data-page]")).not.toContainText(skill);
      await shoot(page, `skill-head-${look}`);

      // The App's card and its head.
      await page.goto(at(`/w/${workspaceId}/apps`));
      await docked();
      // A card's title is under the area of its target, which reads the whole name.
      const card = page.locator("[data-card]").filter({ hasText: WHAT });
      await expectNameFits(
        card.getByRole("heading", { level: 2, name: NAME }),
        card.locator("[data-card-target]"),
        `app card at ${look}`
      );
      await expect(page.getByText(app, { exact: true })).toHaveCount(0);
      await shoot(page, `apps-list-${look}`);
      await page.goto(at(`/w/${workspaceId}/apps/${app}`));
      await docked();
      const appHead = page.locator('header[data-variant="detail"]');
      const appName = appHead.getByRole("heading", { level: 1 });
      await expectNameFits(appName, appName, `app head at ${look}`);
      await shoot(page, `app-head-${look}`);
    }

    // "Copy ID" puts the id on the clipboard and says so in place; the menu stays open.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/build/skills/${skill}`);
    const head = page.locator('header[data-variant="detail"]');
    await expect(head.locator('[data-slot="page-header-description"]')).toHaveText(WHAT);
    await head.getByRole("button", { name: "More actions" }).click();
    const menu = page.getByRole("menu");
    await menu.getByRole("menuitem", { name: "Copy ID" }).click();
    await expect(menu.getByRole("menuitem", { name: "ID copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(skill);
    await shoot(page, "skill-copy-id-1280");
  } finally {
    await requestWithOrigin(page, "post", `${skillUrl}/delete`, {
      data: { expectedRevision: await assetRevision(page, skillUrl) }
    });
  }
});
