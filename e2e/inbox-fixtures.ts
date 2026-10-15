import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect } from "./test";

// What the specs of the Inbox share: who decides, signing in and the pictures of a run.

export const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** May decide skill changes and operation calls, and may view the audit log. */
export const reviewer = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
/** Where the pictures of a run go. Without it a test takes none. */
export const shotsDir = process.env.E2E_SHOTS_DIR;

/**
 * The same view in both languages and both themes, 1280 wide unless the call names other
 * widths. The page is left at the size it came with.
 */
export async function shoot(
  page: Page,
  name: string,
  ready: () => Promise<void>,
  widths: number[] = [1280]
): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  const size = page.viewportSize() ?? { width: 1280, height: 900 };
  for (const width of widths) {
    await page.setViewportSize({ width, height: size.height });
    for (const locale of ["en", "de"] as const) {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(
          ([localeValue, themeValue]) => {
            window.localStorage.setItem("vivd-catalyst:locale", localeValue);
            window.localStorage.setItem("vivd-catalyst:theme", themeValue);
          },
          [locale, theme] as const
        );
        await page.reload();
        await ready();
        await page.screenshot({
          path: join(shotsDir, `${name}-${theme}-${locale}-${width}.png`),
          fullPage: width < 600
        });
      }
    }
  }
  await page.setViewportSize(size);
  await page.evaluate(() => {
    window.localStorage.removeItem("vivd-catalyst:locale");
    window.localStorage.removeItem("vivd-catalyst:theme");
  });
  await page.reload();
  await ready();
}

export async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Search", exact: true })
  ).toBeVisible();
}

/**
 * Goes from the list in front, which holds `row`, to the reader's own empty list, to the
 * decided one and back, and holds the title and the tab row to the place they started at.
 * A tab is read once its list stands: rows, or the sentence of an empty list.
 */
export async function expectInboxFrameStill(inbox: Locator, row: Locator): Promise<void> {
  const title = inbox.getByRole("heading", { name: "Inbox", exact: true });
  const tabList = inbox.getByRole("tablist");
  const places = async () => ({
    title: await title.boundingBox(),
    tabs: await tabList.boundingBox()
  });
  const openTab = async (name: RegExp) => {
    await inbox.getByRole("tab", { name }).click();
    await expect(inbox.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    await expect(inbox.getByRole("tabpanel").getByRole("status")).toHaveCount(0);
    await expect(
      inbox.getByTestId("inbox-row").or(inbox.getByTestId("inbox-empty")).first()
    ).toBeVisible();
  };
  await expect(title).toBeVisible();
  await expect(row).toBeVisible();
  const start = await places();
  expect(start.title).not.toBeNull();
  expect(start.tabs).not.toBeNull();
  await openTab(/^My requests/u);
  await expect(inbox.getByTestId("inbox-empty")).toContainText("You have not requested anything");
  await expect.poll(places).toEqual(start);
  await openTab(/^Decided/u);
  await expect.poll(places).toEqual(start);
  await openTab(/^To decide/u);
  await expect(row).toBeVisible();
  await expect.poll(places).toEqual(start);
}

/**
 * What a tab reads out: its label, and its count with the noun where it has one. The count is
 * a box of its own in the tab, so the name may hold a space before the comma.
 */
export function tabName(label: string, count: number): RegExp {
  return new RegExp(
    count === 0 ? `^${label}$` : `^${label} ?, ${count} ${count === 1 ? "item" : "items"}$`,
    "u"
  );
}

/** The number a Decided tab reads out, 0 when it reads none: an earlier run may have left some. */
export async function decidedCount(tab: Locator): Promise<number> {
  await expect(tab).toHaveAccessibleName(/^Decided(?: ?, \d+ items?)?$/u);
  return Number(/, (\d+) item/u.exec((await tab.textContent()) ?? "")?.[1] ?? 0);
}

/** The id of what an answer of the instance created. */
export function idOf(body: unknown): string {
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    throw new Error("The answer names no id.");
  }
  return body.id;
}
