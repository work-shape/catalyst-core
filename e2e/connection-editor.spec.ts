import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// A Connection made in Build against the demo's sample MCP server, which this file starts on
// the port the suite's `egress.allow` names: "New connection" with the address and a key, the
// tools the instance reads from the server, one of them accepted for agents, a new key, and
// the delete. The key is typed once and never shown again.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
/** The port of `tests/fixtures/e2e-app.yaml` for the sample server; the runner may move it. */
const samplePort = Number(process.env.E2E_SAMPLE_MCP_PORT ?? "4219");
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** Set to a directory to keep pictures of the form and the page. */
const shotsDir = process.env.E2E_SHOTS_DIR;
/** How long the instance may take to read the tools: the discovery is a job. */
const DISCOVERY_TIMEOUT_MS = 45_000;

let sampleServer: ChildProcess | undefined;
const sampleKey = randomBytes(24).toString("base64url");

test.beforeAll(async () => {
  sampleServer = spawn(process.execPath, ["clients/demo/dist/sample-mcp-server.js"], {
    env: {
      ...process.env,
      DEMO_SAMPLE_MCP_KEY: sampleKey,
      HOST: "127.0.0.1",
      PORT: String(samplePort)
    },
    stdio: "ignore"
  });
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${samplePort}/healthz`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15_000 }
    )
    .toBe(200);
});

test.afterAll(() => {
  sampleServer?.kill("SIGTERM");
});

/**
 * Pictures of what stands at the page's address now: light in English and dark in German at
 * 1280, and light at 390. A page without an address, the form of a new Connection, is taken
 * once as it is.
 */
async function shoot(page: Page, name: string, addressed = true): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  const take = (view: string) =>
    page.screenshot({
      path: join(shotsDir, `connection-editor-${name}-${view}.png`),
      fullPage: true
    });
  if (!addressed) {
    await take("1280-en-light");
    return;
  }
  for (const [width, locale, theme] of [
    [1280, "en", "light"],
    [1280, "de", "dark"],
    [390, "en", "light"]
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      ([chosenLocale, chosenTheme]) => {
        window.localStorage.setItem("vivd-catalyst:locale", chosenLocale);
        window.localStorage.setItem("vivd-catalyst:theme", chosenTheme);
      },
      [locale, theme] as const
    );
    await page.reload();
    await page.locator("h1").first().waitFor();
    await take(`${width}-${locale}-${theme}`);
  }
  await page.evaluate(() => {
    window.localStorage.removeItem("vivd-catalyst:locale");
    window.localStorage.removeItem("vivd-catalyst:theme");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
}

test("a person creates an MCP Connection, its tools are read, and one is accepted for agents", async ({
  page
}) => {
  test.setTimeout(120_000);
  const id = `e2e-mcp-${randomUUID().slice(0, 8)}`;
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  const main = page.getByRole("region", { name: "Studio" });

  await page.goto("/build/connections");
  await main.getByRole("button", { name: "New connection" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New connection" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Sample on the suite");
  await dialog.getByRole("textbox", { name: "Id" }).fill(id);
  await dialog.getByRole("button", { name: "Continue" }).click();

  // The form: the address, the scheme and the key. The key field is a password field.
  await main.locator('[data-connection-field="url"]').fill(`http://127.0.0.1:${samplePort}/mcp`);
  await expect(main.getByRole("radio", { name: /Bearer token/u })).toBeChecked();
  const keyField = main.locator('[data-connection-field="secret"]');
  await expect(keyField).toHaveAttribute("type", "password");
  await keyField.fill(sampleKey);
  await shoot(page, "new", false);
  await main.getByRole("button", { name: "Create connection" }).click();

  // The page of the new Connection: the key is set, and the tools of the server are read.
  await expect(page).toHaveURL(new RegExp(`/build/connections/${id}$`, "u"));
  await expect(main.getByRole("heading", { name: "Sample on the suite", level: 1 })).toBeVisible();
  await expect(main.locator('[data-connection-credential="set"]')).toBeVisible();
  const discovered = main.locator('[data-connection-discovered="list_customers"]');
  await expect(discovered).toBeVisible({ timeout: DISCOVERY_TIMEOUT_MS });
  await expect(discovered).toContainText("The server says this tool only reads.");
  await expect(main.locator("[data-connection-discovered]")).toHaveCount(6);
  await shoot(page, "discovered");

  // Accepted, it is an operation agents can carry, and no longer among the discovered ones.
  await main.locator('[data-connection-accept="list_customers"]').click();
  const accepted = main.locator('[data-connection-operation="list_customers"]');
  await expect(accepted).toBeVisible();
  await expect(accepted).toContainText("Agents");
  await expect(accepted).toContainText("Ready", { timeout: DISCOVERY_TIMEOUT_MS });
  await expect(discovered).toHaveCount(0);
  await shoot(page, "accepted");
  const tools = await page.request.get(`${apiBaseUrl}/api/v1/connection-tools`);
  expect(JSON.stringify(await tools.json())).toContain(`connection.${id}.list_customers`);

  // The test reaches the server with the key.
  await main.getByRole("button", { name: "Test connection" }).click();
  await expect(main.locator('[data-connection-health="ready"]')).toBeVisible();

  // A new key replaces the old one; neither is on the page.
  await main.locator("[data-connection-secret-open]").click();
  await main.locator('[data-connection-field="secret"]').fill(sampleKey);
  await main.getByRole("button", { name: "Save key" }).click();
  await expect(main.getByText("The key was saved.")).toBeVisible();
  expect(await page.content()).not.toContain(sampleKey);

  // Deleted, it is gone with its key.
  await main.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: `Delete connection '${id}'?`, exact: true })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page).toHaveURL(/\/build\/connections$/u);
  const gone = await page.request.get(`${apiBaseUrl}/api/v1/connections/${id}`);
  expect(gone.status()).toBe(404);
});
