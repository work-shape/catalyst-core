import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { ALLOWED_URL } from "./connection-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// An earlier attempt left an MCP Connection saved without tools. The list marks it incomplete.
// A new connection under its Id says the Id is taken and by which Connection, and offers to
// open, reconnect or replace it. The owner removes it from the list after one question.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    window.localStorage.setItem("vivd-catalyst:theme", "light");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("de: a taken Id names the Connection that holds it, and the incomplete one is removed from the list", async ({
  page,
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(90000);
  const id = `e2e-taken-${randomUUID().slice(0, 8)}`;
  const title = `Halbe Verbindung ${id.slice(-8)}`;
  const assetUrl = `${apiBaseUrl}/api/v1/assets/connection/${id}`;
  await signIn(page);
  // Saved as an earlier attempt left it: the definition, no tools yet.
  const created = await requestWithOrigin(page, "put", assetUrl, {
    data: {
      expectedRevision: null,
      config: {
        name: id,
        displayName: title,
        connectorType: "mcp",
        settings: { url: ALLOWED_URL },
        authScheme: "none",
        credentialMode: "shared"
      }
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  try {
    await page.goto("/build/connections");
    const main = page.getByRole("region", { name: "Studio" });
    const row = main.getByRole("listitem").filter({ hasText: title });
    await expect(row.locator("[data-connection-incomplete]")).toHaveText("Unvollständig");
    await expect(row).toContainText("Gespeichert, aber noch ohne Tools.");

    // A new MCP server under the same Id.
    await main.getByRole("button", { name: "Neue Verbindung" }).first().click();
    const dialog = page.getByRole("dialog").first();
    await dialog.locator('[data-connection-type="mcp"]').getByRole("button").click();
    await dialog.locator('[data-name-with-address-field="name"]').fill("Zweiter Versuch");
    await dialog.locator("[data-name-with-address-fold]").click();
    await dialog.locator('[data-name-with-address-field="address"]').fill(id);
    await dialog.locator('[data-connection-field="url"]').fill(ALLOWED_URL);
    const taken = dialog.locator("[data-connection-id-taken]");
    await expect(taken).toContainText(`„${title}“ hat diese Id schon`);
    await expect(taken).toContainText("Sie ist unvollständig");
    await expect(dialog).toContainText(`Die Id ${id} gehört schon der Verbindung „${title}“.`);
    await expect(dialog).not.toContainText("Adresse ist vergeben");
    await expect(dialog.locator("[data-connection-connect]")).toBeDisabled();
    await expect(taken.locator("[data-connection-taken-reconnect]")).toBeVisible();
    await expect(taken.locator("[data-connection-taken-replace]")).toBeVisible();

    // Öffnen leads to the Connection that holds the Id.
    await taken.locator("[data-connection-taken-open]").click();
    await expect(page).toHaveURL(new RegExp(`/build/connections/${id}$`, "u"));

    // Its owner removes it from the list after one question.
    await page.goto("/build/connections");
    await row.locator(`[data-build-row-remove="${id}"]`).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText(title);
    await confirm.getByRole("button", { name: "Löschen" }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(async () => (await page.request.get(assetUrl)).status()).toBe(404);
  } finally {
    const found = await page.request.get(assetUrl);
    if (found.ok()) {
      const removed = await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
        data: { expectedRevision: await assetRevision(page, assetUrl) }
      });
      expect(removed.ok(), `Delete Connection during cleanup: ${removed.status()}`).toBe(true);
    }
  }
});
