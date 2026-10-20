import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { availableSamplePort } from "./sample-port.mjs";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { toolRow } from "./tool-packages";

// The shared OAuth sign-in of an MCP Connection (CS-4b4) against the demo's sample MCP server,
// whose small authorization server signs one demo account in without a page to click. The
// New connection dialog meets the server's challenge, shows the step with the provider and the
// permissions, opens the provider in a tab of its own and goes on to the tools once the
// Connection is signed in. A provider that registers no client asks for the one it issued. A
// declined sign-in says so at the step and in the tab it came back to.
//
// The suite's UI and API answer on two origins. `instance.publicUrl` of the suite is the UI's,
// so the provider sends the tab back there; the route below hands the callback on to the API,
// as the reverse proxy of an operated instance does, and the tab follows the API's redirect.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** Set to a directory to keep pictures of each step. */
const shotsDir = process.env.E2E_SHOTS_DIR;
/** How long the instance may take to read the tools: the discovery is a job. */
const DISCOVERY_TIMEOUT_MS = 45_000;
/** Each Connection's sign-in comes back at a path of its own. */
const callbackPathOf = (connection: string) => `/api/v1/connections/${connection}/oauth/callback`;
/**
 * The Connection of the provider that issued a client: the client's redirect URI names it, so
 * the sample server is started knowing it.
 */
const REGISTERED_CONNECTION = `e2e-oauth-en-${randomUUID().slice(0, 8)}`;
const REGISTERED_CLIENT_ID = "e2e-registered-client";

type Locale = "en" | "de";
const WORDS: Record<Locale, { newConnection: string; later: string }> = {
  en: { newConnection: "New connection", later: "Later" },
  de: { newConnection: "Neue Verbindung", later: "Später" }
};

let sampleBase: string;
let sampleServer: ChildProcess | undefined;

test.beforeEach(async ({ releaseConnections: _releaseConnections, baseURL }) => {
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
      SAMPLE_OAUTH_ISSUER_BASE: sampleBase,
      SAMPLE_OAUTH_CLIENT_ID: REGISTERED_CLIENT_ID,
      SAMPLE_OAUTH_REDIRECT_URI: `${baseURL}${callbackPathOf(REGISTERED_CONNECTION)}`
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

/**
 * Plays the provider's page and the trip back. The provider's redirect lands on the callback at
 * the UI's origin, which Playwright cannot route after a redirect; the handler asks the API for
 * the callback itself, as the reverse proxy of an operated instance would, and sends the tab
 * on to where the API sends it. With `deny`, the provider declines instead of signing in.
 */
async function routeProvider(context: BrowserContext, input: { deny?: boolean } = {}) {
  await context.route(`${sampleBase}/*/authorize**`, async (route) => {
    const asked = new URL(route.request().url());
    let back: URL;
    if (input.deny) {
      back = new URL(asked.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("state", asked.searchParams.get("state") ?? "");
    } else {
      const answer = await route.fetch({ maxRedirects: 0 });
      back = new URL(answer.headers().location ?? "");
    }
    expect(back.pathname).toMatch(/^\/api\/v1\/connections\/[^/]+\/oauth\/callback$/u);
    const landed = await context.request.get(`${apiBaseUrl}${back.pathname}${back.search}`, {
      maxRedirects: 0
    });
    expect(landed.status()).toBe(303);
    await route.fulfill({ status: 303, headers: { location: landed.headers().location ?? "" } });
  });
}

/** Pictures of a page as it stands, light, at 1280 and at 390. */
async function shoot(page: Page, locale: Locale, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: join(shotsDir, `connection-sign-in-${name}-${width}-${locale}-light.png`)
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function signInAs(page: Page, locale: Locale): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript((chosen) => {
    window.localStorage.setItem("vivd-catalyst:locale", chosen);
    window.localStorage.setItem("vivd-catalyst:theme", "light");
  }, locale);
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Opens the New connection dialog and connects an MCP server at `path` without a key. */
async function connectWithoutKey(page: Page, locale: Locale, id: string, path: string) {
  await page.goto("/build/connections");
  const main = page.getByRole("region", { name: "Studio" });
  await main.getByRole("button", { name: WORDS[locale].newConnection }).first().click();
  const dialog = page.getByRole("dialog").first();
  await dialog.locator('[data-connection-type="mcp"]').getByRole("button").click();
  await dialog.locator('[data-name-with-address-field="name"]').fill("Sample sign-in");
  await dialog.locator("[data-name-with-address-fold]").click();
  await dialog.locator('[data-name-with-address-field="address"]').fill(id);
  await dialog.locator('[data-connection-field="url"]').fill(`${sampleBase}${path}`);
  await dialog.locator("[data-connection-connect]").click();
  return { main, dialog };
}

/** Clicks the button that opens the provider, and answers the tab it opened. */
async function openProvider(page: Page, dialog: Locator): Promise<Page> {
  const opened = page.waitForEvent("popup");
  await dialog.locator("[data-sign-in-open]").click();
  return opened;
}

async function removeConnection(page: Page, id: string): Promise<void> {
  const url = `${apiBaseUrl}/api/v1/assets/connection/${id}`;
  const found = await page.request.get(url);
  if (found.status() === 404) return;
  expect(found.ok(), `Read Connection before cleanup: ${found.status()}`).toBe(true);
  const removed = await requestWithOrigin(page, "post", `${url}/delete`, {
    data: { expectedRevision: await assetRevision(page, url) }
  });
  expect(removed.ok(), `Delete Connection during cleanup: ${removed.status()}`).toBe(true);
}

test("de: an MCP server that asks for a sign-in is signed in from the dialog, and its tools are approved", async ({
  page
}) => {
  test.setTimeout(150_000);
  const id = `e2e-oauth-de-${randomUUID().slice(0, 8)}`;
  await routeProvider(page.context());
  // The state the provider is handed: it must not stand anywhere in the instance's page.
  const states: string[] = [];
  page.context().on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/authorize")) states.push(url.searchParams.get("state") ?? "");
  });
  await signInAs(page, "de");
  const { main, dialog } = await connectWithoutKey(page, "de", id, "/dcr/mcp");
  try {
    // The server answered with its challenge: the dialog names the provider and the permission.
    const step = dialog.locator('[data-sign-in-step="ready"]');
    await expect(step).toBeVisible();
    await expect(page.getByRole("dialog", { name: /^Anmeldung bei 127\.0\.0\.1/u })).toBeVisible();
    await expect(step.locator("[data-sign-in-shared]")).toHaveText(
      "Alle, die diese Verbindung nutzen dürfen, lesen und handeln über das Konto, mit dem du dich jetzt anmeldest."
    );
    await expect(step.locator('[data-sign-in-scope="sample.read"]')).toBeChecked();
    await shoot(page, "de", "step");

    // The provider signs in at once and sends the tab back; the tab closes itself.
    const tab = await openProvider(page, dialog);
    await tab.waitForEvent("close");
    expect(states).toHaveLength(1);

    const tools = dialog.locator("li[data-approval-tool]");
    await expect(tools).toHaveCount(6, { timeout: DISCOVERY_TIMEOUT_MS });
    await expect(dialog.locator("[data-connection-connected]")).toBeVisible();
    await dialog.locator("[data-connection-approve]").click();
    // Approved for agents, the dialog offers the give to an agent (CS-5d); Done leaves it.
    await dialog.locator("[data-connection-approved-done]").click();

    // The page names the shared sign-in: connected, the permission, nobody else to sign in.
    await expect(page).toHaveURL(new RegExp(`/build/connections/${id}$`, "u"));
    const section = main.locator("[data-connection-sign-in]");
    await expect(section.locator('[data-sign-in-state="connected"]')).toHaveText("Verbunden");
    await expect(section.locator("[data-sign-in-granted]")).toContainText("sample.read");
    await expect(section.locator("[data-sign-in-shared]")).toBeVisible();
    await expect(section.locator("[data-sign-in-begin]")).toHaveText("Neu anmelden");
    await section.scrollIntoViewIfNeeded();
    await shoot(page, "de", "page-connected");

    for (const state of states) {
      expect(state).not.toBe("");
      expect(page.url()).not.toContain(state);
      expect(await page.content()).not.toContain(state);
      expect(
        await page.evaluate(
          () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
        )
      ).not.toContain(state);
    }

    // The agent's Tools: a signed-in Connection's row carries no notice.
    await page.goto("/build/agents/research_assistant");
    const agentTools = page.locator("#tools");
    const row = toolRow(agentTools, `connection:${id}`);
    await expect(row).toBeVisible();
    await expect(row.locator("[data-tool-sign-in-needed]")).toHaveCount(0);

    // Nobody signed in, as after a disconnect: the row says the sign-in is needed. CS-4b3
    // brings the disconnect; until then the instance's answer is replaced here.
    await page.route(`${apiBaseUrl}/api/v1/connections/${id}`, async (route) => {
      const answer = await route.fetch();
      const detail: Record<string, unknown> = await answer.json();
      delete detail.binding;
      await route.fulfill({ response: answer, json: detail });
    });
    await page.reload();
    await expect(row.locator("[data-tool-sign-in-needed]")).toHaveText("Anmeldung nötig");
    await row.scrollIntoViewIfNeeded();
    await shoot(page, "de", "tools-needed");
  } finally {
    await removeConnection(page, id);
  }
});

test("en: a provider that registers no client asks for the one it issued, and an unticked permission is not asked for", async ({
  page,
  baseURL
}) => {
  test.setTimeout(150_000);
  const id = REGISTERED_CONNECTION;
  await routeProvider(page.context());
  const authorizations: URL[] = [];
  page.context().on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/authorize")) authorizations.push(url);
  });
  await signInAs(page, "en");
  const { main, dialog } = await connectWithoutKey(page, "en", id, "/registered/mcp");
  try {
    const client = dialog.locator('[data-sign-in-step="client"]');
    await expect(client).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Register the instance at the provider" })
    ).toBeVisible();
    await expect(client.locator("[data-sign-in-redirect-uri]")).toHaveText(
      `${baseURL}${callbackPathOf(id)}`
    );
    await expect(dialog.locator("[data-sign-in-save-client]")).toBeDisabled();
    await client.locator('[data-sign-in-field="clientId"]').fill(REGISTERED_CLIENT_ID);
    await shoot(page, "en", "client");
    await dialog.locator("[data-sign-in-save-client]").click();

    const step = dialog.locator('[data-sign-in-step="ready"]');
    await expect(step).toBeVisible();
    await step.locator('[data-sign-in-scope="sample.read"]').click();
    await expect(step.locator('[data-sign-in-scope="sample.read"]')).not.toBeChecked();
    const tab = await openProvider(page, dialog);
    await tab.waitForEvent("close");
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.searchParams.get("client_id")).toBe(REGISTERED_CLIENT_ID);
    expect(authorizations[0]?.searchParams.has("scope")).toBe(false);

    await expect(dialog.locator("[data-connection-connected]")).toBeVisible({
      timeout: DISCOVERY_TIMEOUT_MS
    });
    await dialog.getByRole("button", { name: WORDS.en.later }).click();
    await expect(page).toHaveURL(new RegExp(`/build/connections/${id}$`, "u"));
    const section = main.locator("[data-connection-sign-in]");
    await expect(section.locator('[data-sign-in-state="connected"]')).toBeVisible();
    await expect(section).toContainText(REGISTERED_CLIENT_ID);
    await expect(section).toContainText(`${baseURL}${callbackPathOf(id)}`);
    await section.scrollIntoViewIfNeeded();
    await shoot(page, "en", "page-registered");
  } finally {
    await removeConnection(page, id);
  }
});

test("de: a declined sign-in says so at the step and in the tab it came back to", async ({
  page
}) => {
  test.setTimeout(120_000);
  const id = `e2e-oauth-denied-${randomUUID().slice(0, 8)}`;
  // The provider's page declines: it sends the tab back with `access_denied`.
  await routeProvider(page.context(), { deny: true });
  await signInAs(page, "de");
  const { dialog } = await connectWithoutKey(page, "de", id, "/dcr/mcp");
  try {
    await expect(dialog.locator('[data-sign-in-step="ready"]')).toBeVisible();
    const tab = await openProvider(page, dialog);

    // The tab it came back to names the outcome, with nothing of it left in its address.
    await expect(tab.locator('[data-sign-in-landing="oauth_denied"]')).toBeVisible();
    await expect(tab).toHaveURL(/\/build\/connections$/u);
    await expect(tab.getByText("Die Anmeldung hat nicht geklappt")).toBeVisible();
    await expect(
      tab.getByText("Die Anmeldung wurde beim Anbieter abgelehnt oder abgebrochen.")
    ).toBeVisible();
    await shoot(tab, "de", "landing-denied");

    // The dialog heard it at once, and offers the sign-in again.
    const error = dialog.locator('[data-sign-in-error="oauth_denied"]');
    await expect(error).toHaveText(
      /^Die Anmeldung wurde bei 127\.0\.0\.1.* abgelehnt oder abgebrochen\.$/u
    );
    await expect(dialog.locator("[data-sign-in-open]")).toBeEnabled();
    await shoot(page, "de", "step-denied");

    // The tab leaves for the Connection's page.
    await tab.getByRole("button", { name: "Zur Verbindung" }).click();
    await expect(tab).toHaveURL(new RegExp(`/build/connections/${id}$`, "u"));
    await tab.close();
  } finally {
    await removeConnection(page, id);
  }
});
