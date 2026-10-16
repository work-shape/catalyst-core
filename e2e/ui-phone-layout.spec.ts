import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin } from "./view-fixtures";

const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

test("a clipped panel title is available in the library tooltip by pointer and keyboard", async ({
  page
}) => {
  const signedIn = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: { ...adminUser, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.goto("/ui-library");
  await page
    .getByRole("navigation", { name: "Sections of the UI library" })
    .getByRole("button", { name: "Page structure", exact: true })
    .click();
  const shotsDir = process.env.E2E_SHOTS_DIR;
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  for (const locale of ["en", "de"] as const) {
    await page
      .getByRole("group", { name: /^(?:Language|Sprache)$/u })
      .getByRole("button", { name: locale.toUpperCase() })
      .click();
    for (const theme of ["light", "dark"] as const) {
      await choose(
        page,
        locale === "en" ? "Mode" : "Modus",
        theme === "light"
          ? locale === "en"
            ? "Light"
            : "Hell"
          : locale === "en"
            ? "Dark"
            : "Dunkel"
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 640 });
        const shortPanel = page.locator('[data-gallery-sample="surface-short-title"]');
        const shortTitle = shortPanel.getByRole("heading", { level: 2 });
        await shortTitle.scrollIntoViewIfNeeded();
        expect(
          await shortTitle.evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
        await expect(shortTitle).not.toHaveAttribute("tabindex");
        await shortTitle.hover();
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        if (shotsDir && width === 1440)
          await page.screenshot({
            path: join(shotsDir, `phone-panel-short-${theme}-${locale}-${width}.png`),
            animations: "disabled"
          });
        const panel = page.locator('[data-gallery-sample="surface-long-title"]');
        const title = panel.getByRole("heading", { level: 2 });
        await title.scrollIntoViewIfNeeded();
        expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          true
        );
        await expect(title).toHaveAttribute("tabindex", "0");
        const fullTitle = await title.innerText();
        await title.hover();
        await expect(page.getByRole("tooltip")).toHaveText(fullTitle);
        if (shotsDir)
          await page.screenshot({
            path: join(shotsDir, `phone-panel-title-${theme}-${locale}-${width}.png`),
            animations: "disabled"
          });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("tooltip")).toBeHidden();
        await page.mouse.move(0, 0);
        await title.focus();
        await expect(page.getByRole("tooltip")).toHaveText(fullTitle);
        await page.keyboard.press("Escape");
        await title.blur();
      }
    }
  }
});

async function choose(page: Page, group: string, option: string): Promise<void> {
  const button = page.getByRole("group", { name: group }).getByRole("button", { name: option });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}
