import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { sendToolCall } from "./page-surface-fixtures";
import {
  assetBaseRevision,
  assetRevision,
  readAsset,
  requestWithOrigin
} from "./request-with-origin";
import { expect, test } from "./test";

// The Connect card in the chat (CHAT-CONN-2b). An agent calls a tool of the demo's OAuth entry,
// installed for each person's own account, before the person connected: in place of the refused
// call the card appears by itself, with Connect, and no agent text asks for it. Connect signs the
// person in at the sample provider in a window of its own; the card says Connected, the person's
// word that it is connected is sent as theirs, and the agent's next step calls the tool. Where
// the entry has no Connection yet, the agent's proposal of it shows a member "ask your
// administration" and an administrator "Einrichten", which opens the dialog at the entry.
//
// The entry's endpoints are fixed at localhost:8787 (as in connection-catalogue.spec.ts), so the
// sample server answers there with the client it issued for the part's fixed name, and both
// tests take the turn on Connections. The provider's page is played by the route below, which
// hands the callback on to the API, as an operated instance's proxy does.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** From `tests/fixtures/e2e-users/connection-chat-card.yaml`: a member without connection.write. */
const member = {
  email: "e2e-connection-chat-card@example.test",
  password: "e2e-connection-chat-card-password"
};
/** Set to a directory to keep pictures of each state: 1280 light and dark, 390 light. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const ENTRY = "sample-oauth";
const TITLE = "OAuth-Beispiel";
const OAUTH_BASE = "http://localhost:8787";
const CLIENT_ID = "e2e-chat-card-client";
const CLIENT_SECRET = randomBytes(24).toString("base64url");
const TOOL = `connection.${ENTRY}.listCustomers`;
const PROPOSE_TOOL = "platform.connections.propose";
const callbackPath = `/api/v1/connections/${ENTRY}/oauth/callback`;
const connectionUrl = `${apiBaseUrl}/api/v1/assets/connection/${ENTRY}`;
const agentUrl = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;

test.describe.configure({ mode: "serial" });

let oauthServer: ChildProcess | undefined;

async function startProvider(baseURL: string | undefined): Promise<void> {
  oauthServer = spawn(process.execPath, ["clients/demo/dist/sample-mcp-server.js"], {
    env: {
      ...process.env,
      DEMO_SAMPLE_MCP_KEY: randomBytes(24).toString("base64url"),
      // The API reaches localhost on its IPv4 address, where a server on "localhost" may not
      // listen: it binds the first address the name resolves to.
      HOST: "127.0.0.1",
      PORT: "8787",
      SAMPLE_OAUTH_ISSUER_BASE: OAUTH_BASE,
      SAMPLE_OAUTH_REST_CLIENT_ID: CLIENT_ID,
      SAMPLE_OAUTH_REST_CLIENT_SECRET: CLIENT_SECRET,
      SAMPLE_OAUTH_REST_REDIRECT_URI: `${baseURL}${callbackPath}`
    },
    stdio: "ignore"
  });
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${OAUTH_BASE}/healthz`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15_000 }
    )
    .toBe(200);
}

test.afterEach(async () => {
  const server = oauthServer;
  oauthServer = undefined;
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
});

/** Plays the provider's page and the trip back to the API's callback. */
async function routeProvider(context: BrowserContext): Promise<void> {
  await context.route(`${OAUTH_BASE}/oauth-rest/authorize**`, async (route) => {
    const answer = await route.fetch({ maxRedirects: 0 });
    const back = new URL(answer.headers().location ?? "");
    expect(back.pathname).toBe(callbackPath);
    const landed = await context.request.get(`${apiBaseUrl}${back.pathname}${back.search}`, {
      maxRedirects: 0
    });
    expect(landed.status()).toBe(303);
    await route.fulfill({ status: 303, headers: { location: landed.headers().location ?? "" } });
  });
}

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: who.email, password: who.password, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  expect((await page.request.get(`${apiBaseUrl}/api/v1/me`)).ok()).toBe(true);
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("vivd-catalyst:locale")) {
      window.localStorage.setItem("vivd-catalyst:locale", "de");
      window.localStorage.setItem("vivd-catalyst:theme", "light");
    }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Pictures of the conversation as it stands: 1280 light and dark, 390 light. */
async function shoot(page: Page, name: string, ready: Locator): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const [theme, width] of [
    ["light", 1280],
    ["dark", 1280],
    ["light", 390]
  ] as const) {
    await page.evaluate(
      (chosen) => window.localStorage.setItem("vivd-catalyst:theme", chosen),
      theme
    );
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expect(ready).toBeVisible();
    await ready.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shotsDir, `connection-chat-card-${name}-${width}-de-${theme}.png`),
      animations: "disabled"
    });
  }
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:theme", "light"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(ready).toBeVisible();
}

async function storeAgent(page: Page, name: string, toolNames: string[]): Promise<void> {
  const stored = await requestWithOrigin(page, "put", agentUrl(name), {
    data: {
      expectedRevision: await assetBaseRevision(page, agentUrl(name)),
      availableIn: "all",
      config: {
        name,
        displayName: `Karten-Probe ${name.slice(-8)}`,
        description: "Liest die Beispielkunden.",
        instructions: "Hilf mit den Beispielkunden.",
        toolNames
      }
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
}

async function removeAsset(page: Page, url: string): Promise<void> {
  const found = await page.request.get(url);
  if (found.status() === 404) return;
  const removed = await requestWithOrigin(page, "post", `${url}/delete`, {
    data: { expectedRevision: await assetRevision(page, url) }
  });
  expect(removed.ok(), `Delete during cleanup: ${removed.status()}`).toBe(true);
}

async function pickAgent(page: Page, displayName: string): Promise<void> {
  const chip = page.getByRole("button", { name: /^Agent auswählen: /u }).first();
  if ((await chip.getAttribute("title")) !== displayName) {
    await chip.click();
    await page.getByRole("option", { name: displayName }).click();
  }
  await expect(chip).toHaveAttribute("title", displayName);
}

/** A new conversation with the agent, from its card on the Agents page. */
async function chatWith(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+/u);
  await page
    .getByRole("navigation", { name: "Hauptnavigation" })
    .getByRole("button", { name: "Agenten", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Agenten" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: `Karten-Probe ${name.slice(-8)}` }) })
    .getByRole("button", { name: "Chat starten" })
    .click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
}

test("de: a refused call of a personal Connection shows Connect by itself, and the agent carries on once connected", async ({
  page,
  baseURL,
  pageErrors: _pageErrors,
  releaseConnections: _releaseConnections,
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(shotsDir ? 300_000 : 180_000);
  const agent = `e2e_chat_card_${randomUUID().slice(0, 8)}`;
  await startProvider(baseURL);
  await signIn(page, admin);
  await routeProvider(page.context());
  page.setDefaultTimeout(30_000);
  try {
    // The entry's part, installed for each person's own account, its one reading tool given to
    // the agent. Nobody has connected.
    const created = await requestWithOrigin(page, "put", connectionUrl, {
      data: {
        expectedRevision: null,
        config: {
          name: ENTRY,
          displayName: TITLE,
          service: ENTRY,
          catalogue: { entry: ENTRY, part: "tools", version: 1 },
          connectorType: "http_api",
          authScheme: "oauth",
          credentialMode: "user",
          settings: {
            baseUrl: `${OAUTH_BASE}/oauth-rest/api`,
            testPath: "/customers",
            oauth: {
              authorizationUrl: `${OAUTH_BASE}/oauth-rest/authorize`,
              tokenUrl: `${OAUTH_BASE}/oauth-rest/token`,
              revocationUrl: `${OAUTH_BASE}/oauth-rest/revoke`,
              tokenAuthMethod: "client_secret_post",
              clientId: CLIENT_ID,
              scopes: ["sample.identity", "sample.read"]
            }
          },
          operations: [
            {
              name: "listCustomers",
              description: "Read the invented customers from the sample server.",
              effect: "reading",
              exposure: ["agent"],
              enabled: true,
              method: "GET",
              path: "/customers",
              shaper: "sample.customers"
            }
          ]
        }
      }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const secret = await requestWithOrigin(
      page,
      "put",
      `${apiBaseUrl}/api/v1/connections/${ENTRY}/secret`,
      {
        data: {
          value: CLIENT_SECRET,
          expectedVersion: null,
          expectedRevision: await assetRevision(page, connectionUrl)
        }
      }
    );
    expect(secret.ok(), await secret.text()).toBe(true);
    await storeAgent(page, agent, [TOOL]);

    // The agent calls the tool: the card stands in place of the refusal, with Connect.
    await chatWith(page, agent);
    await sendToolCall(page, TOOL, {});
    const card = page.locator(`[data-connect-card][data-connection="${ENTRY}"]`);
    await expect(card).toHaveAttribute("data-connect-card", "connect");
    await expect(card).toContainText(`${TITLE} verbinden`);
    await expect(card.locator('[data-connect-card-connect="connect"]')).toHaveText("Verbinden");
    await expect(card).not.toContainText("@");
    await expect(page.locator("[data-connection-draft-open]")).toHaveCount(0);
    await shoot(page, "connect", card);
    // A reload for the pictures forgets the conversation's agent; the person's word goes to it.
    if (shotsDir) await pickAgent(page, `Karten-Probe ${agent.slice(-8)}`);

    // Connect opens the provider in a window of its own; it signs in and closes.
    const opened = page.waitForEvent("popup");
    await card.locator('[data-connect-card-connect="connect"]').click();
    await (await opened).waitForEvent("close", { timeout: 30_000 });
    await expect(card).toHaveAttribute("data-connect-card", "connected");

    // The person's word is sent as theirs, and the agent's next step reads the customers.
    await expect(page.getByText(`${TITLE} ist verbunden.`, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Muster GmbH/u).first()).toBeVisible({ timeout: 60_000 });
    await shoot(page, "connected", card);
    const stored = await readAsset(page, connectionUrl);
    expect(JSON.stringify(stored)).not.toContain(CLIENT_SECRET);
  } finally {
    await removeAsset(page, agentUrl(agent));
    await removeAsset(page, connectionUrl);
  }
});

test("de: where the entry is not set up, a member is told to ask the administration and an admin sets it up", async ({
  page,
  browser,
  baseURL,
  releaseConnections: _releaseConnections,
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(shotsDir ? 300_000 : 150_000);
  const agent = `e2e_chat_card_${randomUUID().slice(0, 8)}`;
  await signIn(page, admin);
  page.setDefaultTimeout(30_000);
  const memberContext = await browser.newContext({ baseURL });
  const memberPage = await memberContext.newPage();
  memberPage.setDefaultTimeout(30_000);
  try {
    expect((await page.request.get(connectionUrl)).status()).toBe(404);
    await storeAgent(page, agent, [PROPOSE_TOOL]);
    const proposal = { entry: { id: ENTRY, part: "tools" } };

    // A member: the sentence, and no button.
    await signIn(memberPage, member);
    await chatWith(memberPage, agent);
    await sendToolCall(memberPage, PROPOSE_TOOL, proposal);
    const asked = memberPage.locator(`[data-connect-card][data-connection="${ENTRY}"]`);
    await expect(asked).toHaveAttribute("data-connect-card", "ask_admin");
    await expect(asked).toContainText(
      `${TITLE} ist hier noch nicht eingerichtet; frag deine Administration.`
    );
    await expect(asked.getByRole("button")).toHaveCount(0);
    await shoot(memberPage, "ask-admin", asked);

    // An administrator: the proposal opens New connection at the entry, with the chat docked
    // beside it (CHAT-CONN-1); closed, the card's Einrichten opens it again.
    await chatWith(page, agent);
    await sendToolCall(page, PROPOSE_TOOL, proposal);
    const intro = page.getByRole("dialog").locator(`[data-catalogue-intro="${ENTRY}"]`);
    await expect(intro).toBeVisible();
    await expect(page).toHaveURL(/\/build\/connections/u);
    await page.keyboard.press("Escape");
    await expect(intro).toHaveCount(0);
    const setup = page.locator(`[data-connect-card][data-connection="${ENTRY}"]`);
    await expect(setup).toHaveAttribute("data-connect-card", "setup");
    await expect(setup.locator("[data-connect-card-setup]")).toHaveText("Einrichten");
    await shoot(page, "setup", setup);
    await setup.locator("[data-connect-card-setup]").click();
    await expect(intro).toBeVisible();
  } finally {
    await removeAsset(page, agentUrl(agent));
    await memberContext.close();
  }
});
