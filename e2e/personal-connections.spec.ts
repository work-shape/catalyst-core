import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { z } from "zod";
import { availableSamplePort } from "./sample-port.mjs";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Personal connections (CS-9a-UI) against the demo's sample MCP server, whose small
// authorization server signs one demo account in without a page to click. The administrator
// makes a personal MCP Connection and gives one person the right to use it. The person connects
// their own account under You > Connections, in a window of its own, and reads Connected. The
// administrator finds the person under People on the Connection's page and revokes the sign-in;
// the person then reads Not connected, and on the Connection's page, which they may not change,
// finds no People section.
//
// As in connection-sign-in.spec.ts, the provider sends the window back to the UI's origin and
// the route below hands the callback on to the API, as an operated instance's proxy does.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** From `tests/fixtures/e2e-users/personal-connections.yaml`. */
const person = {
  email: "e2e-personal-connections@example.test",
  password: "e2e-personal-connections-password",
  label: "E2E Zz Personal Connections"
};
/** Set to a directory to keep pictures of each step, light and dark, at 1280 and at 390. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const idSchema = z.object({ id: z.string() });

let sampleBase: string;
let sampleServer: ChildProcess | undefined;

test.beforeEach(async () => {
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

async function signIn(page: Page, who: { email: string; password: string }): Promise<string> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: who.email, password: who.password, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // The instance knows a person of the config from their first call on.
  const me = await page.request.get(`${apiBaseUrl}/api/v1/me`);
  expect(me.ok()).toBe(true);
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("vivd-catalyst:locale")) {
      window.localStorage.setItem("vivd-catalyst:locale", "de");
      window.localStorage.setItem("vivd-catalyst:theme", "light");
    }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  return idSchema.parse(await me.json()).id;
}

/** Pictures of the page as it stands, light and dark, at 1280 and at 390. */
async function shoot(page: Page, name: string, ready: Locator): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(
      (chosen) => window.localStorage.setItem("vivd-catalyst:theme", chosen),
      theme
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await expect(ready).toBeVisible();
      await page.screenshot({
        path: join(shotsDir, `personal-connections-${name}-${width}-de-${theme}.png`),
        animations: "disabled",
        fullPage: true
      });
    }
  }
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:theme", "light"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(ready).toBeVisible();
}

async function grant(page: Page, holderId: string, action: string, scopeId: string) {
  const granted = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/access/grants`,
    {
      data: { holderKind: "user", holderId, action, effect: "allow", scopeKind: "asset", scopeId }
    }
  );
  expect(granted.ok(), await granted.text()).toBe(true);
  return idSchema.parse(await granted.json()).id;
}

test("de: a person connects their own account, the admin sees and revokes it, and the person may not see who else connected", async ({
  page,
  browser,
  baseURL,
  pageErrors,
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(shotsDir ? 300_000 : 150_000);
  const id = `e2e-personal-${randomUUID().slice(0, 8)}`;
  const title = "Persönliches Postfach";
  const assetUrl = `${apiBaseUrl}/api/v1/assets/connection/${id}`;
  await signIn(page, admin);
  const personContext = await browser.newContext({ baseURL });
  await pageErrors.watch(personContext);
  await routeProvider(personContext);
  const personPage = await personContext.newPage();
  const personId = await signIn(personPage, person);
  for (const each of [page, personPage]) each.setDefaultTimeout(30_000);

  const created = await requestWithOrigin(page, "put", assetUrl, {
    data: {
      expectedRevision: null,
      config: {
        name: id,
        displayName: title,
        connectorType: "mcp",
        settings: { url: `${sampleBase}/dcr/mcp` },
        authScheme: "oauth",
        credentialMode: "user"
      }
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const grants: string[] = [];
  try {
    const assetId = idSchema.parse(await (await page.request.get(assetUrl)).json()).id;
    grants.push(await grant(page, personId, "connection.read", assetId));
    grants.push(await grant(page, personId, "connection.use", assetId));

    // You > Connections: the Connection, not connected yet.
    await personPage.goto("/settings/you/connections");
    const card = personPage.locator(`[data-personal-connection="${id}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(title);
    await expect(card.locator("[data-personal-state]")).toHaveText("Nicht verbunden");
    await shoot(personPage, "you-not-connected", card);

    // Connect shows the step with the provider, then opens it in a window of its own.
    await card.locator('[data-personal-connect="connect"]').click();
    const step = card.locator('[data-sign-in-step="ready"]');
    await expect(step).toBeVisible();
    await expect(step.locator("[data-sign-in-personal]")).toBeVisible();
    await shoot(personPage, "you-step", step);
    const opened = personPage.waitForEvent("popup");
    await step.locator("[data-sign-in-open]").click();
    const popup = await opened;
    await popup.waitForEvent("close");
    await expect(card.locator("[data-personal-state]")).toHaveText(/^Verbunden/u);
    await expect(card.locator("[data-personal-disconnect]")).toBeVisible();
    await shoot(personPage, "you-connected", card.locator('[data-personal-state="connected"]'));

    // The administrator finds the person under People and revokes the sign-in.
    await page.goto(`/build/connections/${id}`);
    const people = page.locator("[data-connection-people]");
    const row = people.locator(`[data-person="${personId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(person.label);
    await expect(row.locator("[data-personal-state]")).toHaveText(/^Verbunden/u);
    await expect(people.locator("[data-provider-grant-stays]")).toBeVisible();
    await row.scrollIntoViewIfNeeded();
    await shoot(page, "people", row);
    await row.locator("[data-person-revoke]").click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("Die Freigabe beim Anbieter bleibt");
    await confirm.getByRole("button", { name: "Widerrufen" }).click();
    await expect(row.locator("[data-personal-state]")).toHaveText("Nicht verbunden");
    await expect(row.locator("[data-person-revoke]")).toHaveCount(0);

    // The person reads Not connected again, and may connect again.
    await personPage.reload();
    await expect(card.locator("[data-personal-state]")).toHaveText("Nicht verbunden");
    await expect(card.locator('[data-personal-connect="connect"]')).toBeVisible();

    // On the Connection's page the person connects their own account; who else did stays hidden.
    await personPage.goto(`/build/connections/${id}`);
    const own = personPage.locator("[data-personal-sign-in]");
    await expect(own).toBeVisible();
    await expect(own.locator("[data-personal-state]")).toHaveText("Nicht verbunden");
    await expect(personPage.locator("[data-connection-people]")).toHaveCount(0);
    await expect(personPage.locator("#people")).toHaveCount(0);
  } finally {
    for (const grantId of grants) {
      await requestWithOrigin(
        page,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grantId}`
      );
    }
    const found = await page.request.get(assetUrl);
    if (found.ok()) {
      const removed = await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
        data: { expectedRevision: await assetRevision(page, assetUrl) }
      });
      expect(removed.ok(), `Delete Connection during cleanup: ${removed.status()}`).toBe(true);
    }
    await personContext.close();
  }
});
