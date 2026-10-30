import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type PageErrorWatch } from "./test";

// OP-2: an admin reads each action's policy in plain words on Settings > Instance > Policies,
// sets a central setting for one and removes it, and locks "Always allow" for it and lifts the
// lock again, at phone width in light and dark. A lock of the release config is shown and the
// screen cannot lift it; the API refuses too. The suite's server brings both actions
// (clients/demo/src/e2e-server.ts) and its config locks `e2e.policy_locked`.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const NARROW = { width: 390, height: 844 };
const shotsDir = process.env.E2E_SHOTS_DIR;
const admin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const OPEN = "e2e.policy_reversible";
const LOCKED = "e2e.policy_locked";
const settingsUrl = `${apiBaseUrl}/api/v1/instance/policies/settings`;
const locksUrl = `${apiBaseUrl}/api/v1/instance/policies/always-allow-locks`;

async function sessionOf(
  browser: Browser,
  watch: PageErrorWatch["watch"],
  colorScheme: "light" | "dark"
): Promise<Page> {
  const context = await browser.newContext({ viewport: NARROW, colorScheme });
  await watch(context);
  const page = await context.newPage();
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  return page;
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
}

/** Opens an action's row on the page, found by the search. */
async function openRow(page: Page, operation: string) {
  await page.getByRole("searchbox", { name: "Search actions" }).fill(operation);
  const row = page.locator(`[data-testid="policy-operation"][data-operation="${operation}"]`);
  await row.getByRole("button", { expanded: false }).first().click();
  return row;
}

// One test, light and then dark, since both change the same action of the instance.
test("an admin sets an action's policy and its lock, and cannot lift a lock of the release config", async ({
  browser,
  pageErrors
}) => {
  test.setTimeout(180_000);
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await sessionOf(browser, pageErrors.watch, colorScheme);
    try {
      await page.goto("/settings/instance/policies");
      await expect(page.getByRole("heading", { name: "Policies", exact: true })).toBeVisible();
      await expect(page.getByTestId("policy-defaults")).toContainText(
        "Actions that change something"
      );

      // The action runs by its own default; the admin makes it wait for an approval.
      let row = await openRow(page, OPEN);
      await expect(row).toHaveAttribute("data-value", "allow");
      await expect(row.getByTestId("policy-operation-sentence")).toHaveText(
        "Runs without asking (default of this action)"
      );
      await row.getByRole("combobox", { name: `Policy of ${OPEN}` }).selectOption("approval");
      await expect(row).toHaveAttribute("data-value", "approval");
      await expect(row.getByTestId("policy-operation-sentence")).toHaveText(
        "Waits for an approval by someone who may approve it (set here)"
      );
      const setting = page.locator(`[data-testid="policy-setting"][data-operation="${OPEN}"]`);
      await expect(setting).toContainText("Needs an approval");

      // The admin locks "Always allow" for it; the lock is listed as set here.
      const always = row.getByTestId("policy-always-allow");
      await always.getByRole("switch").click();
      await expect(always).toHaveAttribute("data-locked", "instance");
      const lock = page.locator(`[data-testid="policy-lock"][data-operation="${OPEN}"]`);
      await expect(lock).toContainText("Set here");
      await expectNoSidewaysScroll(page);
      await shoot(page, `policies-set-${colorScheme}-390`);

      // Both are undone: the setting removed, the lock lifted.
      await setting.getByRole("button", { name: `Remove the setting for ${OPEN}` }).click();
      await expect(setting).toHaveCount(0);
      await lock.getByRole("button", { name: `Lift the lock for ${OPEN}` }).click();
      await expect(lock).toHaveCount(0);
      await expect(row).toHaveAttribute("data-value", "allow");
      await expect(always).not.toHaveAttribute("data-locked", /.+/u);

      // The release config locks the other: the screen says so and offers no way to lift it.
      row = await openRow(page, LOCKED);
      const locked = row.getByTestId("policy-always-allow");
      await expect(locked).toHaveAttribute("data-locked", "release");
      await expect(locked.getByRole("switch")).toBeDisabled();
      await expect(locked).toContainText("The technical team locks Always allow for this action.");
      const releaseLock = page.locator(
        `[data-testid="policy-lock"][data-operation="${LOCKED}"][data-source="release"]`
      );
      await expect(releaseLock).toContainText("Technical team");
      await expect(releaseLock.getByRole("button")).toHaveCount(0);
      await expectNoSidewaysScroll(page);
      await shoot(page, `policies-release-lock-${colorScheme}-390`);

      // The API refuses to lift it too.
      const refused = await requestWithOrigin(page, "put", locksUrl, {
        data: { operation: LOCKED, locked: false }
      });
      expect(refused.status()).toBe(403);
    } finally {
      await requestWithOrigin(page, "put", settingsUrl, { data: { operation: OPEN, value: null } });
      await requestWithOrigin(page, "put", locksUrl, { data: { operation: OPEN, locked: false } });
    }
  }
});
