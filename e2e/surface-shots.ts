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

/**
 * Pictures of a screen at 1280 and 390 pixels, light and dark, in English and German, where
 * `E2E_SHOTS_DIR` names a folder. Each picture loads the address again and waits for `ready`;
 * the page is left light, in English, at the width it had.
 */
export async function shootEverywhere(
  page: Page,
  name: string,
  ready: () => Promise<void>
): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  const size = page.viewportSize();
  const show = async (theme: string, locale: string) => {
    await page.evaluate(
      ([themeValue, localeValue]) => {
        window.localStorage.setItem("vivd-catalyst:theme", themeValue);
        window.localStorage.setItem("vivd-catalyst:locale", localeValue);
      },
      [theme, locale] as const
    );
    await page.reload();
    await ready();
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    for (const theme of ["light", "dark"]) {
      for (const locale of ["en", "de"]) {
        await show(theme, locale);
        await page.screenshot({
          path: join(shotsDir, `${name}-${width}-${theme}-${locale}.png`),
          animations: "disabled"
        });
      }
    }
  }
  if (size) {
    await page.setViewportSize(size);
  }
  await show("light", "en");
}
