import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./test";
import { requestWithOrigin } from "./request-with-origin";

// WS-BUILD-1: an instance admin gives Builder in a workspace on Instance > Access and sets the
// workspace's build limits on Instance > Workspaces.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const shotsDir = process.env.E2E_SHOTS_DIR;
const normalUser = { email: "e2e-user@example.test", password: "e2e-user-password" };
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function pick(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** The theme of a picture run, set before the first page loads: the app keeps it from there. */
const shotsTheme = process.env.E2E_SHOTS_THEME === "dark" ? "dark" : "light";

/** One picture per width, where pictures are asked for. */
async function pictures(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const [width, size] of [
    ["wide", WIDE],
    ["narrow", NARROW]
  ] as const) {
    await page.setViewportSize(size);
    await page.screenshot({ path: join(shotsDir, `${name}-${shotsTheme}-${width}.png`) });
  }
  await page.setViewportSize(WIDE);
}

test("an instance admin gives Builder in a workspace and sets the workspace's build limits", async ({
  page,
  // Grant rows of the instance are counted by the Access page's own test.
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(90_000);
  await page.addInitScript((theme) => {
    window.localStorage.setItem("vivd-catalyst:theme", theme);
  }, shotsTheme);
  await signInViaApi(page, normalUser);
  const holder: { id: string } = await (await page.request.get(`${apiBaseUrl}/api/v1/me`)).json();
  await signInViaApi(page, adminUser);
  const name = `Builder bundles ${Date.now()}`;
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name }
  });
  expect(created.ok()).toBe(true);
  const workspace: { id: string } = await created.json();
  await page.setViewportSize(WIDE);
  try {
    // Builder in the workspace, one right: no scope step, the workspace picked.
    await page.goto("/settings/instance/access");
    await page.getByRole("tab", { name: /^Rights/u }).click();
    await page.getByRole("button", { name: "New right" }).click();
    const dialog = page.getByRole("dialog", { name: "New right" });
    await pick(page, dialog.getByRole("button", { name: /^Person: / }), /E2E User/u);
    await dialog.getByRole("radio", { name: "Building in a workspace" }).check();
    await expect(dialog.getByRole("radio", { name: /^On one asset/u })).toHaveCount(0);
    await dialog.getByLabel("Builder", { exact: true }).check();
    await pick(page, dialog.getByRole("button", { name: /^Workspace/u }), name);
    await pictures(page, "access-new-builder");
    await dialog.getByRole("button", { name: "Create right" }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByTestId("grant-row").filter({ hasText: name });
    await expect(row).toContainText("E2E User");
    await expect(row).toContainText("Builder");
    await pictures(page, "access-builder-row");

    // The workspace's limits: off, then one tool.
    await page.goto("/settings/instance/workspaces");
    const limits = page.getByTestId("workspace-limits-row").filter({ hasText: name });
    await expect(limits).toContainText("No limit");
    await pictures(page, "workspaces-page");
    await limits.getByRole("button", { name: `Edit the limits of ${name}` }).click();
    const limitsDialog = page.getByRole("dialog", { name: `Limits of ${name}` });
    await limitsDialog.getByRole("switch", { name: "Limit tools" }).click();
    await limitsDialog.getByRole("button", { name: "Choose tools" }).click();
    await page.getByRole("option").first().click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await pictures(page, "workspaces-limits-dialog");
    await limitsDialog.getByRole("button", { name: "Save" }).click();
    await expect(limitsDialog).toBeHidden();
    await expect(limits).toContainText("1 listed");

    // The same page and dialog in German.
    if (shotsDir) {
      await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
      await page.reload();
      await expect(limits).toContainText("1 gelistet");
      await limits.getByRole("button", { name: `Grenzen von ${name} bearbeiten` }).click();
      await pictures(page, "workspaces-limits-dialog-de");
      await page.keyboard.press("Escape");
      await page.goto("/settings/instance/access");
      await page.getByRole("tab", { name: /^Rechte/u }).click();
      await page.getByRole("button", { name: "Neues Recht" }).click();
      await page.getByRole("radio", { name: "Bauen in einem Arbeitsbereich" }).check();
      await pictures(page, "access-new-builder-de");
    }
  } finally {
    const rows: { items: { id: string; action: string; scopeId?: string }[] } = await (
      await page.request.get(`${apiBaseUrl}/api/v1/instance/access/grants`, {
        params: { holderKind: "user", holderId: holder.id }
      })
    ).json();
    for (const grant of rows.items.filter((item) => item.scopeId === workspace.id)) {
      await requestWithOrigin(
        page,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grant.id}`
      );
    }
  }
});
