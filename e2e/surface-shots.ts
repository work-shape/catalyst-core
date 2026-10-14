import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

const shotsDir = process.env.E2E_SHOTS_DIR;

async function loadIn(page: Page, theme: string, ready: () => Promise<void>): Promise<void> {
  await page.evaluate((value) => window.localStorage.setItem("vivd-catalyst:theme", value), theme);
  await page.reload();
  await ready();
}

/**
 * Pictures of what stands beside the conversation, in the light and the dark theme, where
 * `E2E_SHOTS_DIR` names a folder. The theme is read when the interface loads, so each one loads
 * the address again and waits for `ready`; the page is left in the light theme.
 */
export async function shootThemes(
  page: Page,
  name: string,
  ready: () => Promise<void>
): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await loadIn(page, theme, ready);
    await page.screenshot({ path: join(shotsDir, `${name}-${theme}.png`), animations: "disabled" });
  }
  await loadIn(page, "light", ready);
}

/**
 * Pictures of a screen in English and in German, light, 1280 pixels wide, where
 * `E2E_SHOTS_DIR` names a folder. Each language loads the address again and waits for `ready`;
 * the page is left in English at the width it had.
 */
export async function shootLocales(
  page: Page,
  name: string,
  ready: () => Promise<void>
): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  const size = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:theme", "light"));
  for (const locale of ["en", "de"]) {
    await page.evaluate(
      (value) => window.localStorage.setItem("vivd-catalyst:locale", value),
      locale
    );
    await page.reload();
    await ready();
    await page.screenshot({
      path: join(shotsDir, `${name}-${locale}.png`),
      animations: "disabled"
    });
  }
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
  if (size) {
    await page.setViewportSize(size);
  }
  await page.reload();
  await ready();
}
