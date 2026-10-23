import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";
import { requestWithOrigin } from "./request-with-origin";

// OP-6: "Always allow" on the confirmation of a reversible call. The call runs, and the next
// call of the same operation runs without a card. Settings > You > Confirmations lists the
// choice, and setting it back to the administrator's setting makes the call ask again. The
// suite's server holds `e2e.confirm_reversible` for a confirmation (clients/demo/src/e2e-server.ts).

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const shotsDir = process.env.E2E_SHOTS_DIR;
const TOOL = "e2e.confirm_reversible";

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByPlaceholder("Message")).toBeVisible();
}

async function askFor(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder("Message").fill(`/tool ${TOOL} ${JSON.stringify({ text })}`);
  await page.getByRole("button", { name: "Send message" }).click();
}

/** Light and dark at 1280, light at 390, of what `target` finds after a reload. */
async function shoot(page: Page, name: string, target: (page: Page) => Locator): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  const size = page.viewportSize() ?? { width: 1280, height: 900 };
  for (const [width, theme] of [
    [1280, "light"],
    [1280, "dark"],
    [390, "light"]
  ] as const) {
    await page.setViewportSize({ width, height: size.height });
    await page.evaluate((value) => {
      window.localStorage.setItem("vivd-catalyst:theme", value);
    }, theme);
    await page.reload();
    const found = target(page);
    await expect(found).toBeVisible();
    await found.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shotsDir, `${name}-${theme}-${width}.png`) });
  }
  await page.setViewportSize(size);
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:theme", "light"));
  await page.reload();
}

test("Always allow runs the call, and the next call of it runs without asking", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 180_000 : 90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await askFor(page, `First note ${Date.now()}`);

  const card = page.getByTestId("tool-decision-card");
  await expect(card).toBeVisible();
  const alwaysAllow = card.getByRole("button", { name: "Always allow", exact: true });
  await expect(alwaysAllow).toBeVisible();
  await expect(card).toContainText("Always allow also lets your scheduled runs do this");
  await shoot(page, "always-allow-card", (current) => current.getByTestId("tool-decision-card"));

  await page
    .getByTestId("tool-decision-card")
    .getByRole("button", { name: "Always allow" })
    .click();
  await expect(page.getByTestId("tool-decision-card")).toHaveCount(0);
  await expect(page.getByText(/Tool work completed/u).last()).toBeVisible();

  // The next call runs at once: no card.
  const second = `Second note ${Date.now()}`;
  await page.goto("/");
  await expect(page.getByPlaceholder("Message")).toBeVisible();
  await askFor(page, second);
  const answer = page.locator('[data-role="assistant"]').filter({ hasText: second }).last();
  await expect(answer).toContainText(/Tool work completed/u);
  await expect(page.getByTestId("tool-decision-card")).toHaveCount(0);

  // Settings > You > Confirmations shows the choice; the administrator's setting asks again.
  await page.goto("/settings/you/confirmations");
  const row = page.locator(`[data-testid="confirmation-setting"][data-operation="${TOOL}"]`);
  await expect(row).toBeVisible();
  const choice = row.getByRole("combobox");
  await expect(choice).toHaveValue("always_allow");
  await shoot(page, "always-allow-settings", (current) =>
    current.getByTestId("confirmation-settings")
  );
  await page
    .locator(`[data-testid="confirmation-setting"][data-operation="${TOOL}"]`)
    .getByRole("combobox")
    .selectOption("default");
  await expect(
    page
      .locator(`[data-testid="confirmation-setting"][data-operation="${TOOL}"]`)
      .getByRole("combobox")
  ).toHaveValue("default");

  await page.goto("/");
  await expect(page.getByPlaceholder("Message")).toBeVisible();
  await askFor(page, `Third note ${Date.now()}`);
  await expect(page.getByTestId("tool-decision-card")).toBeVisible();
  await page
    .getByTestId("tool-decision-card")
    .getByRole("button", { name: "Deny", exact: true })
    .click();
  await expect(page.getByTestId("tool-decision-card")).toHaveCount(0);
  // The denied run ends before the spec does.
  await expect(page.getByText(/Tool work completed/u).last()).toBeVisible();
});
