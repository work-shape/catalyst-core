import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Request } from "@playwright/test";
import { assetRevision, readAsset, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// A Connector type with a form of its own in the New connection dialog: the suite's folder
// source, a document source that reaches nothing. Its card stands beside an MCP server and a
// REST API; its form asks for the fields the type declares. A refused secret empties the
// field and says so; the right one connects, and the Connection's page opens. In English and
// in German, at 1280 and at 390.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** Set to a directory to keep pictures of each step. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const LOCALES = ["en", "de"] as const;
type Locale = (typeof LOCALES)[number];
const WORDS: Record<Locale, { newConnection: string; title: string; heading: string }> = {
  en: { newConnection: "New connection", title: "Test folders", heading: "Connect Test folders" },
  de: { newConnection: "Neue Verbindung", title: "Testordner", heading: "Testordner verbinden" }
};

// Connections are instance-wide: keep the turn of the other Connection specs.
test.beforeEach(async ({ releaseConnections: _releaseConnections }) => undefined);

async function shoot(page: Page, locale: Locale, name: string, width: number): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({
    path: join(shotsDir, `connection-typed-${name}-${width}-${locale}-light.png`)
  });
}

async function removeConnection(page: Page, id: string): Promise<void> {
  const url = `${apiBaseUrl}/api/v1/assets/connection/${id}`;
  const found = await page.request.get(url);
  if (found.status() === 404) return;
  const removed = await requestWithOrigin(page, "post", `${url}/delete`, {
    data: { expectedRevision: await assetRevision(page, url) }
  });
  expect(removed.ok(), `Delete Connection during cleanup: ${removed.status()}`).toBe(true);
}

for (const locale of LOCALES) {
  for (const width of [1280, 390]) {
    test(`${locale} at ${width}: a document source is connected from its own form after a refused secret`, async ({
      page
    }) => {
      const id = `e2e-folders-${locale}-${width}-${randomUUID().slice(0, 8)}`;
      const writes: string[] = [];
      page.on("request", (request: Request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() !== "GET" && path.includes(`/${id}`)) {
          writes.push(`${request.method()} ${path.replace(id, ":name")}`);
        }
      });
      const signedIn = await requestWithOrigin(
        page,
        "post",
        `${apiBaseUrl}/api/auth/sign-in/email`,
        { data: { ...admin, rememberMe: true } }
      );
      expect(signedIn.ok()).toBe(true);
      await page.addInitScript((chosen) => {
        window.localStorage.setItem("vivd-catalyst:locale", chosen);
        window.localStorage.setItem("vivd-catalyst:theme", "light");
      }, locale);
      await page.setViewportSize({ width, height: 900 });
      try {
        await page.goto("/build/connections");
        const main = page.getByRole("region", { name: "Studio" });
        await main.getByRole("button", { name: WORDS[locale].newConnection }).first().click();
        const dialog = page.getByRole("dialog").first();
        const card = dialog.locator('[data-connection-type="test_folders"]');
        await expect(card).toContainText(WORDS[locale].title);
        await shoot(page, locale, "pick", width);
        await card.getByRole("button").click();
        await expect(page.getByRole("dialog", { name: WORDS[locale].heading })).toBeVisible();

        const field = (name: string) => dialog.locator(`[data-connection-field="${name}"]`);
        const connect = dialog.locator("[data-connection-connect]");
        await expect(connect).toBeDisabled();
        await dialog.locator('[data-name-with-address-field="name"]').fill("Folders of the suite");
        await dialog.locator("[data-name-with-address-fold]").click();
        await dialog.locator('[data-name-with-address-field="address"]').fill(id);
        await field("accountId").fill("account-7");
        // The test folder is optional: Verbinden waits only for the account and the secret.
        await expect(connect).toBeDisabled();
        await expect(field("secret")).toHaveAttribute("type", "password");
        await field("secret").fill("refused-secret");
        await expect(connect).toBeEnabled();
        await shoot(page, locale, "form", width);

        // The type's test refuses the secret: the field is empty and says so.
        await connect.click();
        await expect(field("secret")).toHaveAttribute("aria-invalid", "true");
        await expect(field("secret")).toHaveValue("");
        await expect(dialog.locator("[data-connection-create-saved]")).toBeVisible();
        await shoot(page, locale, "refused", width);

        await field("secret").fill(`right-${randomUUID()}`);
        await connect.click();
        await expect(page).toHaveURL(new RegExp(`/build/connections/${id}$`, "u"));
        await expect(dialog).toHaveCount(0);
        await shoot(page, locale, "page", width);

        // The definition holds the type's fixed settings and the account, and no secret.
        const stored = await readAsset(page, `${apiBaseUrl}/api/v1/assets/connection/${id}`);
        expect(stored?.config).toMatchObject({
          connectorType: "test_folders",
          authScheme: "client_credentials",
          settings: { accountId: "account-7", region: "eu" },
          operations: []
        });
        expect(JSON.stringify(stored)).not.toContain("right-");
        expect(writes).toEqual([
          "PUT /api/v1/assets/connection/:name",
          "PUT /api/v1/connections/:name/secret",
          "POST /api/v1/connections/:name/test",
          "PUT /api/v1/assets/connection/:name",
          "PUT /api/v1/connections/:name/secret",
          "POST /api/v1/connections/:name/test"
        ]);
        // No horizontal scroll at the phone width.
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true);
      } finally {
        await removeConnection(page, id);
      }
    });
  }
}
