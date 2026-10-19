import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin } from "./view-fixtures";

// The published Apps under the Apps row of the rail fold behind a caret. Felix, 2026-10-19:
// "either design them nicer and collapsible or leave them out for now". They stand folded at
// first; the caret opens them by pointer and by key and the browser keeps the choice; the row
// itself still opens the Apps page; five are listed, then "All apps"; the App on screen opens
// the fold; the strip of icons shows none. Fails without the fold: the Apps stand open as plain
// text rows with no caret.

const idSchema = z.object({ id: z.string() });
const FOLD_KEY = "vivd-catalyst:rail-apps-open";
const TITLES = [
  "Scope review",
  "Quarterly scope review for the northern region",
  "Fee estimate",
  "Customer list",
  "Trip planner",
  "Lease checker",
  "Tax calendar"
];

/** Saves an App by its files and publishes its first revision to the workspace. */
async function publishApp(page: Page, workspaceId: string, appId: string, title: string) {
  const address = `${apiOrigin}/api/v1/assets/app/${appId}`;
  const saved = await requestWithOrigin(page, "put", address, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        {
          path: "app.yaml",
          text: `id: ${appId}\nname: ${title}\nkit: 1.2.0\nentry: index.html\n`
        },
        {
          path: "index.html",
          text: `<!doctype html><html><body><h1>${title}</h1></body></html>`
        }
      ]
    },
    timeout: 90_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const published = await requestWithOrigin(page, "post", `${address}/publish`, {
    data: { workspaceId, revision: 1, audience: "workspace" }
  });
  expect(published.ok(), await published.text()).toBe(true);
}

function railOf(page: Page): Locator {
  return page.getByRole("navigation", { name: /^(?:Main navigation|Hauptnavigation)$/u });
}

test("the Apps under the Apps row fold behind a caret the browser remembers", async ({ page }) => {
  test.setTimeout(300_000);
  const signedIn = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: { email: "e2e-admin@example.test", password: "e2e-admin-password", rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: `Rail apps ${randomUUID().slice(0, 6)}` }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const suffix = randomUUID().slice(0, 6);
  const ids = TITLES.map((_, index) => `rail-app-${index}-${suffix}`);
  // The last one published is changed last, so the rail lists it first.
  for (const [index, title] of [...TITLES.entries()].reverse()) {
    await publishApp(page, workspaceId, ids[index] ?? "", title);
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/w/${workspaceId}`);
  await page.evaluate((key) => window.localStorage.removeItem(key), FOLD_KEY);
  await page.reload();
  const rail = railOf(page);
  const toggle = rail.getByTestId("rail-apps-toggle");
  const items = rail.getByTestId("rail-apps");

  // Folded at first, behind a caret that names what it does.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAccessibleName("Show apps");
  await expect(items).toHaveCount(0);

  // The keyboard opens it.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName("Hide apps");
  await expect(items.getByRole("button")).toHaveCount(6);
  await expect(items.getByRole("button").first()).toHaveText(/Scope review/u);
  await expect(items.getByTestId("rail-apps-all")).toHaveText("All apps");

  // A long name is cut at the rail's edge and named whole on the pointer.
  const long = items.getByRole("button", { name: TITLES[1] });
  await expect(long).toHaveAttribute("title", TITLES[1] ?? "");
  const cut = await long
    .locator("span.truncate")
    .evaluate((label) => label.scrollWidth > label.clientWidth);
  expect(cut).toBe(true);

  // The Apps' marks start where the Apps row's label starts.
  const appsLabel = rail.getByRole("button", { name: "Apps", exact: true }).locator("span").first();
  const labelX = (await appsLabel.boundingBox())?.x ?? 0;
  const markX = (await items.locator('[data-kind="app"]').first().boundingBox())?.x ?? -1;
  expect(Math.abs(markX - labelX)).toBeLessThanOrEqual(1);

  // The choice is kept over a reload.
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // The row opens the Apps page and leaves the fold as it is.
  await rail.getByRole("button", { name: "Apps", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/apps$`, "u"));
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // An App opens from its row and is the current row.
  await items.getByRole("button", { name: "Fee estimate" }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${ids[2]}$`, "u"));
  await expect(items.getByRole("button", { name: "Fee estimate" })).toHaveAttribute(
    "aria-current",
    "true"
  );

  // Pictures, open on an App, light and dark, 1280 and 390.
  const shotsDir = process.env.E2E_SHOTS_DIR;
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    for (const width of [1280, 390]) {
      for (const theme of ["light", "dark"]) {
        for (const locale of ["en", "de"]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await page.evaluate(
            ({ theme, locale }) => {
              window.localStorage.setItem("vivd-catalyst:theme", theme);
              window.localStorage.setItem("vivd-catalyst:locale", locale);
            },
            { theme, locale }
          );
          await page.reload();
          if (width === 390) {
            await page
              .getByRole("button", { name: /^(?:Open sidebar|Seitenleiste öffnen)$/u })
              .click();
          }
          await expect(items.getByRole("button").first()).toBeVisible();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          await expect(
            page.getByTestId("app-view").getByRole("heading", { name: "Fee estimate" }).first()
          ).toBeVisible();
          // No row shows its hover in the picture.
          await page.mouse.move(width - 20, 600);
          await page.screenshot({
            path: join(shotsDir, `rail-apps-open-${theme}-${locale}-${width}.png`),
            animations: "disabled"
          });
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      window.localStorage.setItem("vivd-catalyst:theme", "light");
      window.localStorage.setItem("vivd-catalyst:locale", "en");
    });
    await page.reload();
  }

  // Folded on an App, the Apps row is the current one, and the fold is kept folded.
  await toggle.click();
  await expect(items).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "Apps", exact: true })).toHaveAttribute(
    "aria-current",
    "true"
  );
  await page.goto(`/w/${workspaceId}`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  if (shotsDir) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (value) => window.localStorage.setItem("vivd-catalyst:theme", value),
        theme
      );
      await page.reload();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await page.mouse.move(1260, 600);
      await page.screenshot({
        path: join(shotsDir, `rail-apps-folded-${theme}-en-1280.png`),
        animations: "disabled"
      });
    }
  }

  // Opening an App by its address opens the fold for it, without changing the choice.
  await page.goto(`/w/${workspaceId}/apps/${ids[4]}`);
  await expect(items.getByRole("button", { name: "Trip planner" })).toHaveAttribute(
    "aria-current",
    "true"
  );
  expect(await page.evaluate((key) => window.localStorage.getItem(key), FOLD_KEY)).toBe("closed");

  // "All apps" opens the page with every App.
  await items.getByTestId("rail-apps-all").click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/apps$`, "u"));

  // The strip of icons shows the Apps row alone.
  await rail.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(toggle).toHaveCount(0);
  await expect(items).toHaveCount(0);
  await rail.getByRole("button", { name: "Expand sidebar" }).click();
});
