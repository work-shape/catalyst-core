import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Pictures of the New connection dialog and of the page of a Connection that signs in, for a
// person to look at: the dialog's first step, and the page with its lead line, its sign-in,
// what agents may do with it and the folded Settings, in German, light and dark, at 1280. It
// runs only with CONN_PAGE_SHOTS=1 and writes to test-results/conn-page (CONN_PAGE_SHOTS_DIR
// names another directory). The Connection is the demo's OAuth entry, installed for one shared
// account against the sample provider, as connection-catalogue.spec.ts does.
const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

const SHOTS = resolve(process.env.CONN_PAGE_SHOTS_DIR ?? "test-results/conn-page");
const ENTRY = "sample-oauth";
const OAUTH_BASE = "http://localhost:8787";
const CLIENT_ID = "e2e-screens-client";
const CLIENT_SECRET = randomBytes(24).toString("base64url");
const callbackPath = `/api/v1/connections/${ENTRY}/oauth/callback`;
const connectionUrl = `${apiBaseUrl}/api/v1/assets/connection/${ENTRY}`;

/** Opens the Connection's page in German and one theme, and waits for its sign-in. */
async function view(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/build/connections/${ENTRY}`);
  await page.evaluate((chosen) => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    window.localStorage.setItem("vivd-catalyst:theme", chosen);
  }, theme);
  await page.reload();
  await expect(page.locator('[data-sign-in-state="connected"]').first()).toBeVisible();
  await expect(page.locator("[data-connection-operation]").first()).toBeAttached();
}

/**
 * The whole page in one picture. The content scrolls inside the page, not the window, so the
 * window is made as tall as the content first.
 */
async function picture(page: Page, label: string): Promise<void> {
  const extra = await page.locator("[data-connection-sign-in]").evaluate((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const overflowY = getComputedStyle(parent).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        return parent.scrollHeight - parent.clientHeight;
      }
    }
    return 0;
  });
  await page.setViewportSize({ width: 1280, height: 900 + Math.max(0, extra) });
  await page.screenshot({
    path: resolve(SHOTS, `conn-page-${label}.png`),
    fullPage: true,
    animations: "disabled"
  });
}

/** Unfolds a folded part of the page, where the page has it. */
async function unfold(page: Page, selector: string): Promise<boolean> {
  const trigger = page.locator(selector).first();
  if ((await trigger.count()) === 0) return false;
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  return true;
}

test.describe("pictures of the New connection dialog and of a Connection's page", () => {
  test.skip(process.env.CONN_PAGE_SHOTS !== "1", "Runs only with CONN_PAGE_SHOTS=1.");
  let provider: ChildProcess | undefined;

  test.afterEach(async ({ page }) => {
    if ((await page.request.get(connectionUrl)).ok()) {
      await requestWithOrigin(page, "post", `${connectionUrl}/delete`, {
        data: { expectedRevision: await assetRevision(page, connectionUrl) }
      });
    }
    const server = provider;
    provider = undefined;
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
  });

  test("de: the dialog's first step, and the page light, dark and with Settings open", async ({
    page,
    baseURL,
    releaseConnections: _releaseConnections
  }) => {
    test.setTimeout(240_000);
    await mkdir(SHOTS, { recursive: true });
    provider = spawn(process.execPath, ["clients/demo/dist/sample-mcp-server.js"], {
      env: {
        ...process.env,
        DEMO_SAMPLE_MCP_KEY: randomBytes(24).toString("base64url"),
        HOST: "::",
        PORT: "8787",
        SAMPLE_OAUTH_ISSUER_BASE: OAUTH_BASE,
        SAMPLE_OAUTH_REST_CLIENT_ID: CLIENT_ID,
        SAMPLE_OAUTH_REST_CLIENT_SECRET: CLIENT_SECRET,
        SAMPLE_OAUTH_REST_REDIRECT_URI: `${baseURL}${callbackPath}`
      },
      stdio: "ignore"
    });
    const started = provider;
    await expect
      .poll(
        async () => {
          if (started.exitCode !== null) return started.exitCode;
          try {
            return (await fetch(`${OAUTH_BASE}/healthz`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 15_000 }
      )
      .toBe(200);
    // The provider's page is played: its answer goes to the API, which the UI's origin is not.
    const context = page.context();
    await context.route(`${OAUTH_BASE}/oauth-rest/authorize**`, async (route) => {
      const answer = await route.fetch({ maxRedirects: 0 });
      const back = new URL(answer.headers().location ?? "");
      const landed = await context.request.get(`${apiBaseUrl}${back.pathname}${back.search}`, {
        maxRedirects: 0
      });
      await route.fulfill({ status: 303, headers: { location: landed.headers().location ?? "" } });
    });

    const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
      data: { ...admin, rememberMe: true }
    });
    expect(signedIn.ok()).toBe(true);
    await page.addInitScript(() => {
      window.localStorage.setItem("vivd-catalyst:locale", "de");
      if (window.localStorage.getItem("vivd-catalyst:theme") === null) {
        window.localStorage.setItem("vivd-catalyst:theme", "light");
      }
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/build/connections");
    const main = page.getByRole("region", { name: "Studio" });

    // The New connection dialog at its first step, and with what a developer connects unfolded.
    await main.getByRole("button", { name: "Neue Verbindung" }).first().click();
    const pick = page.getByRole("dialog").first();
    await expect(pick.locator("[data-connection-type]").first()).toBeAttached();
    await page.screenshot({
      path: resolve(SHOTS, "conn-create-de-light.png"),
      animations: "disabled"
    });
    if (await unfold(page, "[data-connection-own-trigger]")) {
      await page.screenshot({
        path: resolve(SHOTS, "conn-create-de-light-own.png"),
        animations: "disabled"
      });
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The OAuth entry, for one shared account, approved and signed in.
    const card = main.locator(`[data-catalogue-entry="${ENTRY}"]`);
    await card.locator("[data-catalogue-start]").click();
    const dialog = page.getByRole("dialog").first();
    await expect(dialog.locator(`[data-catalogue-intro="${ENTRY}"]`)).toBeVisible();
    await dialog.locator('[data-connection-field="credentialMode"]').getByText("Geteilt").click();
    await dialog.locator('[data-connection-field="oauth.clientId"]').fill(CLIENT_ID);
    await dialog.locator('[data-connection-field="secret"]').fill(CLIENT_SECRET);
    await dialog.locator("[data-connection-connect]").click();
    await expect(page.locator("[data-catalogue-review]")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("dialog").first().locator("[data-connection-approve]").click();
    const step = page.getByRole("dialog").first();
    await expect(step.locator('[data-sign-in-step="ready"]')).toBeVisible();
    const tab = page.waitForEvent("popup");
    await step.locator("[data-sign-in-open]").click();
    await (await tab).waitForEvent("close");
    await expect(step.locator("[data-connection-approved]")).toBeVisible({ timeout: 30_000 });

    for (const theme of ["light", "dark"] as const) {
      await view(page, theme);
      await picture(page, `de-${theme}`);
    }
    await view(page, "light");
    if (await unfold(page, "[data-asset-settings-trigger]")) {
      await picture(page, "de-light-settings");
    }
  });
});
