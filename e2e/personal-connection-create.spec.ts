import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { BrowserContext } from "@playwright/test";
import { availableSamplePort } from "./sample-port.mjs";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// A personal MCP server made in the New connection dialog against the demo's sample MCP server,
// whose small authorization server signs one demo account in without a page to click. The
// dialog saves it, never tests it, asks the person for their own sign-in, and then reads its
// tools with that sign-in: the one exception to CS-9b's owner-only agent call (manager
// ruling, 2026-10-30). The tools are approved and the Connection's page holds them.
//
// As in personal-connections.spec.ts, the provider sends the tab back to the UI's origin and
// the route below hands the callback on to the API, as an operated instance's proxy does.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** How long the instance may take to read the tools: the discovery is a job. */
const DISCOVERY_TIMEOUT_MS = 45000;

let sampleBase: string;
let sampleServer: ChildProcess | undefined;

test.beforeEach(async ({ releaseConnections: _releaseConnections }) => {
  const samplePort = await availableSamplePort(
    (process.env.E2E_SAMPLE_MCP_PORTS ?? "4219").split(",").map(Number)
  );
  sampleBase = `http://127.0.0.1:${samplePort}`;
  sampleServer = spawn(process.execPath, ["clients/demo/dist/sample-mcp-server.js"], {
    env: {
      ...process.env,
      DEMO_SAMPLE_MCP_KEY: randomUUID() + randomUUID(),
      HOST: "127.0.0.1",
      PORT: String(samplePort),
      SAMPLE_OAUTH_ISSUER_BASE: sampleBase
    },
    stdio: "ignore"
  });
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${sampleBase}/healthz`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15_000 }
    )
    .toBe(200);
});

test.afterEach(async () => {
  const server = sampleServer;
  sampleServer = undefined;
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
});

/** Plays the provider's page and the trip back to the API's callback. */
async function routeProvider(context: BrowserContext) {
  await context.route(`${sampleBase}/*/authorize**`, async (route) => {
    const answer = await route.fetch({ maxRedirects: 0 });
    const back = new URL(answer.headers().location ?? "");
    expect(back.pathname).toMatch(/^\/api\/v1\/connections\/[^/]+\/oauth\/callback$/u);
    const landed = await context.request.get(`${apiBaseUrl}${back.pathname}${back.search}`, {
      maxRedirects: 0
    });
    expect(landed.status()).toBe(303);
    await route.fulfill({ status: 303, headers: { location: landed.headers().location ?? "" } });
  });
}

test("en: a personal MCP server is made in the dialog, signed in with the person's own account, and its tools are read and approved", async ({
  page
}) => {
  test.setTimeout(150000);
  const id = `e2e-personal-create-${randomUUID().slice(0, 8)}`;
  const assetUrl = `${apiBaseUrl}/api/v1/assets/connection/${id}`;
  await routeProvider(page.context());
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path.includes(`/${id}`)) {
      writes.push(`${request.method()} ${path.replace(id, ":name")}`);
    }
  });
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "en");
    window.localStorage.setItem("vivd-catalyst:theme", "light");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  try {
    await page.goto("/build/connections");
    const main = page.getByRole("region", { name: "Studio" });
    await main.getByRole("button", { name: "New connection" }).first().click();
    const dialog = page.getByRole("dialog").first();
    await dialog.locator('[data-connection-type="mcp"]').getByRole("button").click();
    await dialog.locator('[data-name-with-address-field="name"]').fill("My sample");
    await dialog.locator("[data-name-with-address-fold]").click();
    await dialog.locator('[data-name-with-address-field="address"]').fill(id);
    await dialog.locator('[data-connection-field="url"]').fill(`${sampleBase}/dcr/mcp`);
    const mode = dialog.locator('[data-connection-field="credentialMode"]');
    await mode.getByRole("radio").nth(1).check();
    await expect(mode).toHaveAttribute("data-credential-mode", "user");
    await dialog.locator("[data-connection-connect]").click();

    // Saved without a test: the person signs in with their own account.
    await expect(dialog.locator('[data-sign-in-step="ready"]')).toBeVisible();
    const opened = page.waitForEvent("popup");
    await dialog.locator("[data-sign-in-open]").click();
    const tab = await opened;
    await tab.waitForEvent("close");

    // The tools come from the owner's own sign-in.
    const tools = dialog.locator("li[data-approval-tool]");
    await expect(tools).toHaveCount(6, { timeout: DISCOVERY_TIMEOUT_MS });
    await expect(dialog.locator("[data-connection-connected]")).toBeVisible();
    await dialog.locator("[data-connection-approve]").click();
    await dialog.locator("[data-connection-approved-done]").click();
    await expect(page).toHaveURL(new RegExp(`/build/connections/${id}$`, "u"));
    await expect(main.locator("[data-connection-operation]").first()).toBeVisible();

    // Never a test of the personal Connection: the write, the sign-in, the discovery, the approval.
    expect(writes).not.toContain("POST /api/v1/connections/:name/test");
    expect(writes).toContain("POST /api/v1/connections/:name/discover");
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
