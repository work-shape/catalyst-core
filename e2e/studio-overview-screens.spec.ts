import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Pictures of where Studio opens, for a person to look at: the overview in German, light and
// dark, with "Neu" open, and as it stands while nothing is built, at 1280. On the way it starts
// a Connection from "Neu" and opens a list from its row. It runs only with
// STUDIO_SHOTS=1 and writes to test-results/studio-overview (STUDIO_SHOTS_DIR names another
// directory).
const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

const SHOTS = resolve(process.env.STUDIO_SHOTS_DIR ?? "test-results/studio-overview");

/** Opens Studio's own address in German and one theme, and waits for what it reads. */
async function view(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto("/build");
  await page.evaluate((chosen) => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    window.localStorage.setItem("vivd-catalyst:theme", chosen);
  }, theme);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("region", { name: "Studio" }).getByRole("list").first()
  ).toBeVisible();
}

async function picture(page: Page, label: string): Promise<void> {
  await page.screenshot({
    path: resolve(SHOTS, `studio-${label}.png`),
    animations: "disabled"
  });
}

test.describe("pictures of where Studio opens", () => {
  test.skip(process.env.STUDIO_SHOTS !== "1", "Runs only with STUDIO_SHOTS=1.");

  test("de: the overview light and dark, with New open, and with nothing built", async ({
    page
  }) => {
    test.setTimeout(120_000);
    await mkdir(SHOTS, { recursive: true });
    const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
      data: { ...admin, rememberMe: true }
    });
    expect(signedIn.ok()).toBe(true);

    for (const theme of ["light", "dark"] as const) {
      await view(page, theme);
      await picture(page, `de-${theme}`);
    }

    await view(page, "light");
    const newButton = page.locator("[data-build-overview-new]");
    if ((await newButton.count()) > 0) {
      await newButton.click();
      await expect(page.getByRole("menu")).toBeVisible();
      await picture(page, "de-light-new");
      // What the menu starts is the kind's own: the list of Connections with its dialog open.
      await page.getByRole("menuitem", { name: "Neue Verbindung" }).click();
      await expect(page).toHaveURL(/\/build\/connections$/u);
      await expect(page.getByRole("dialog").first()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // A row leads to its kind's list, and "Übersicht" in the rail leads back.
      await view(page, "light");
      await page.locator('[data-build-overview-kind="skills"] a').click();
      await expect(page).toHaveURL(/\/build\/skills$/u);
      await expect(page.getByRole("heading", { level: 1, name: "Skills" })).toBeVisible();
      await page.getByRole("navigation").getByRole("button", { name: "Übersicht" }).click();
      await expect(page).toHaveURL(/\/build$/u);
      await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
    }

    // Nothing built: every list of assets answers with none, whatever the instance holds.
    await page.route(/\/api\/v1\/assets\/[^/?]+(?:\?.*)?$/u, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ json: { items: [] } });
    });
    await view(page, "light");
    await picture(page, "de-light-empty");
  });
});
