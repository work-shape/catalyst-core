import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { z } from "zod";
import { availableSamplePort } from "./sample-port.mjs";
import { sendToolCall } from "./page-surface-fixtures";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { requestAnswered } from "./allowed-page-errors";
import { expect, test } from "./test";

// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "own-server-names-no-sign-in",
        reason:
          "Chromium's own log line: the key-guarded sample answers a Bearer challenge without a " +
          "sign-in to be found, the sign-in start is answered with 409, and the test asserts " +
          "that the dialog asks for a token instead.",
        matches: requestAnswered(409),
        path: /^\/api\/v1\/connections\/[^/]+\/oauth\/start$/u,
        tests: [
          "en: a person adds their own MCP server with a pasted token instead of a sign-in, replaces the token, and removes it"
        ]
      }
    ]
  }
});

// A person's own MCP server (PMCP-5, connections acceptance check 81) against the demo's sample
// MCP server in its Dynamic Client Registration mode, whose small authorization server signs
// one demo account in without a page to click. A person with the role `user` alone and no
// Connection right adds it on You > Connections: the address, Verbinden, the sign-in in another
// tab, the tools with `liest` and `ändert`, Fertig. The server then shows as a card; under
// "Tools ändern" a changing tool its owner always allows says so, and "Wieder fragen" takes it
// back. "Entfernen" deletes it.
//
// The suite's API judges a self-added server by its egress list, which names the sample on the
// loopback (`ownServersByOperatorListForTests` in clients/demo/src/e2e-server.ts): the rule of
// a self-added server refuses every private address. As in personal-connections.spec.ts, the
// provider sends the tab back to the UI's origin and the route below hands the callback on to
// the API, as an operated instance's proxy does.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
/** From `tests/fixtures/e2e-users/own-mcp-server.yaml`. */
const person = {
  email: "e2e-own-mcp-server@example.test",
  password: "e2e-own-mcp-server-password"
};
/** Set to a directory to keep pictures of each step, light and dark, at 1280 and at 390. */
const shotsDir = process.env.E2E_SHOTS_DIR;
/** How long the instance may take to read the tools: the discovery is a job. */
const DISCOVERY_TIMEOUT_MS = 45_000;

const mineSchema = z.object({
  connections: z.array(
    z.object({
      name: z.string(),
      service: z.string().optional(),
      ownServer: z.object({ tools: z.number() }).optional()
    })
  ),
  ownServers: z
    .object({
      mayAdd: z.boolean(),
      entries: z.array(z.object({ id: z.string(), url: z.string() })).optional()
    })
    .optional()
});
const settingsSchema = z.object({
  items: z.array(z.object({ operation: z.string(), value: z.string().optional() }))
});

let sampleBase: string;
/** The key that guards the sample's `/mcp`: the token a person pastes for it. */
let sampleKey: string;
let sampleServer: ChildProcess | undefined;

test.beforeEach(async () => {
  const samplePort = await availableSamplePort(
    (process.env.E2E_SAMPLE_MCP_PORTS ?? "4219").split(",").map(Number)
  );
  sampleBase = `http://127.0.0.1:${samplePort}`;
  sampleKey = randomUUID() + randomUUID();
  sampleServer = spawn(process.execPath, ["clients/demo/dist/sample-mcp-server.js"], {
    env: {
      ...process.env,
      DEMO_SAMPLE_MCP_KEY: sampleKey,
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

/** Starts the sample MCP server at `base`, its `/mcp` guarded by `key`, and waits for it. */
async function startSampleAt(base: string, key: string): Promise<ChildProcess> {
  const server = spawn(process.execPath, ["clients/demo/dist/sample-mcp-server.js"], {
    env: {
      ...process.env,
      DEMO_SAMPLE_MCP_KEY: key,
      HOST: "127.0.0.1",
      PORT: new URL(base).port,
      SAMPLE_OAUTH_ISSUER_BASE: base
    },
    stdio: "ignore"
  });
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${base}/healthz`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15_000 }
    )
    .toBe(200);
  return server;
}

async function stopSample(server: ChildProcess | undefined): Promise<void> {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
}

/**
 * The address the instance gives one of the demo's own-server entries (PMCP-CAT): the suite's
 * sample server on a port of its own (clients/demo/src/e2e-server.ts).
 */
async function entryAddress(page: Page, id: string): Promise<URL> {
  const entry = (await mine(page)).ownServers?.entries?.find((candidate) => candidate.id === id);
  expect(entry, `The own-server entry ${id} is offered`).toBeDefined();
  return new URL(entry?.url ?? "");
}

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
async function routeProvider(context: BrowserContext, base = sampleBase) {
  await context.route(`${base}/*/authorize**`, async (route) => {
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

async function signIn(page: Page, locale: "de" | "en") {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // With screenshots the theme follows the system's mode, so a shot switches it without a
  // reload that would close the dialog.
  const theme = shotsDir ? "system" : "light";
  await page.addInitScript(
    ([chosen, mode]) => {
      if (!window.localStorage.getItem("vivd-catalyst:locale")) {
        window.localStorage.setItem("vivd-catalyst:locale", chosen);
        window.localStorage.setItem("vivd-catalyst:theme", mode);
      }
    },
    [locale, theme] as const
  );
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** The person's own list as the instance answers it. */
async function mine(page: Page) {
  const answer = await page.request.get(`${apiBaseUrl}/api/v1/me/connections`);
  expect(answer.ok()).toBe(true);
  return mineSchema.parse(await answer.json());
}

/** Deletes every server the person added: a run never leaves one for the next. */
async function removeOwnServers(page: Page) {
  for (const row of (await mine(page)).connections) {
    if (row.ownServer === undefined) continue;
    const assetUrl = `${apiBaseUrl}/api/v1/assets/connection/${row.name}`;
    const removed = await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
      data: { expectedRevision: await assetRevision(page, assetUrl) }
    });
    expect(removed.ok(), `Delete own server during cleanup: ${removed.status()}`).toBe(true);
  }
}

/**
 * Pictures of what is open now, light and dark, at 1280 and at 390, without a reload: an open
 * dialog stays open. The theme is the attribute the page's styles read.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      await page.screenshot({
        path: join(shotsDir, `own-mcp-server-${name}-${width}-${theme}.png`),
        animations: "disabled",
        fullPage: true
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("de: a person adds their own MCP server, signs in in another tab, chooses its tools, always allows one and takes it back, and removes it", async ({
  page,
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(shotsDir ? 300_000 : 180_000);
  await routeProvider(page.context());
  await signIn(page, "de");
  await removeOwnServers(page);
  try {
    expect((await mine(page)).ownServers?.mayAdd).toBe(true);
    await page.goto("/settings/you/connections");
    const section = page.locator("[data-own-servers]");
    await expect(section.getByRole("heading", { name: "Deine MCP-Server" })).toBeVisible();
    await expect(section.locator("[data-own-servers-empty]")).toBeVisible();
    await shoot(page, "empty");

    await section.getByRole("button", { name: "MCP-Server hinzufügen" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('[data-own-server-field="address"]').fill(`${sampleBase}/dcr/mcp`);
    await shoot(page, "address");
    await dialog.getByRole("button", { name: "Verbinden" }).click();

    // Saved and probed: the server asks for a sign-in, which runs in another tab.
    await expect(dialog.locator('[data-sign-in-step="ready"]')).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /^Anmeldung bei / })).toBeVisible();
    await shoot(page, "sign-in");
    const opened = page.waitForEvent("popup");
    await dialog.locator("[data-sign-in-open]").click();
    const tab = await opened;
    await tab.waitForEvent("close");

    // The tools the owner's own sign-in read, each with what it does.
    const tools = dialog.locator("li[data-approval-tool]");
    await expect(tools).toHaveCount(6, { timeout: DISCOVERY_TIMEOUT_MS });
    await expect(dialog.locator('[data-own-server-field="title"]')).toHaveValue("127.0.0.1");
    await dialog.locator('[data-own-server-field="title"]').fill("Meine Notizen");
    // The sample's tools all read; the owner marks one as changing, which they may.
    await expect(dialog.locator("li[data-approval-tool]").getByText("liest")).not.toHaveCount(0);
    const changingTool = await tools.first().getAttribute("data-approval-tool");
    expect(changingTool).toBeTruthy();
    const changingRow = dialog.locator(`li[data-approval-tool="${changingTool ?? ""}"]`);
    await changingRow.locator("select[data-approval-effect]").selectOption("changing");
    await changingRow.getByRole("checkbox").check();
    await expect(changingRow.getByRole("checkbox")).toBeChecked();
    await shoot(page, "tools");
    await dialog.getByRole("button", { name: "Fertig" }).click();
    await expect(dialog).toBeHidden();

    // The card: name, host, state and tools.
    const card = page.locator("[data-own-server-card]");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Meine Notizen");
    await expect(card).toContainText("127.0.0.1");
    await expect(card.locator('[data-own-server-state="connected"]')).toBeVisible();
    const name = (await card.getAttribute("data-own-server-card")) ?? "";
    expect(name).toMatch(/^mcp-127-0-0-1-[a-z0-9]{6}$/u);
    const listed = (await mine(page)).connections.find((row) => row.name === name);
    expect(listed?.ownServer?.tools).toBeGreaterThan(1);
    await expect(card).toContainText(`${listed?.ownServer?.tools ?? 0} Tools`);
    await shoot(page, "card");

    // The owner always allows the changing tool, as a confirmation card would set it.
    const operation = `connection.${name}.${changingTool ?? ""}`;
    const set = await requestWithOrigin(page, "put", `${apiBaseUrl}/api/v1/me/operation-settings`, {
      data: { operation, value: "always_allow" }
    });
    expect(set.ok(), await set.text()).toBe(true);

    await card.getByRole("button", { name: "Tools ändern" }).click();
    const toolsDialog = page.getByRole("dialog");
    await expect(
      toolsDialog.getByRole("heading", { name: "Tools von Meine Notizen" })
    ).toBeVisible();
    const allowed = toolsDialog.locator(`[data-own-server-always-allowed="${changingTool ?? ""}"]`);
    await expect(allowed).toHaveText("Immer erlauben");
    await shoot(page, "change-tools");
    await toolsDialog.getByRole("button", { name: "Wieder fragen" }).click();
    await expect(allowed).toBeHidden();
    const settings = settingsSchema.parse(
      await (await page.request.get(`${apiBaseUrl}/api/v1/me/operation-settings`)).json()
    );
    expect(settings.items.find((item) => item.operation === operation)?.value).toBeUndefined();
    await toolsDialog.getByRole("button", { name: "Schließen" }).click();
    await expect(toolsDialog).toBeHidden();

    // Entfernen: one confirmation, then the server is gone.
    await card.getByRole("button", { name: "Entfernen" }).click();
    const confirm = page.getByRole("dialog", { name: "Meine Notizen entfernen?" });
    await confirm.getByRole("button", { name: "Entfernen" }).click();
    await expect(page.locator("[data-own-server-card]")).toHaveCount(0);
    await expect(section.locator("[data-own-servers-empty]")).toBeVisible();
    expect((await mine(page)).connections.some((row) => row.name === name)).toBe(false);
  } finally {
    await removeOwnServers(page);
  }
});

test("en: an address with a password, or one that is no MCP server, is refused at the field and nothing stays", async ({
  page,
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(90_000);
  await signIn(page, "en");
  await removeOwnServers(page);
  try {
    await page.goto("/settings/you/connections");
    const section = page.locator("[data-own-servers]");
    await section.getByRole("button", { name: "Add MCP server" }).click();
    const dialog = page.getByRole("dialog");
    const address = dialog.locator('[data-own-server-field="address"]');
    await address.fill("https://me:secret@notes.example.test/mcp");
    await dialog.getByRole("button", { name: "Connect" }).click();
    await expect(dialog).toContainText("Leave the name and password out of the address");

    // Reachable, and no MCP server: saved, probed, and deleted again.
    await address.fill(`${sampleBase}/no-such-server`);
    await dialog.getByRole("button", { name: "Connect" }).click();
    await expect(dialog).toContainText("did not answer as an MCP server", { timeout: 30_000 });
    await shoot(page, "unreachable");
    expect((await mine(page)).connections.filter((row) => row.ownServer)).toEqual([]);
  } finally {
    await removeOwnServers(page);
  }
});

test("en: a person adds their own MCP server with a pasted token instead of a sign-in, replaces the token, and removes it", async ({
  page,
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(shotsDir ? 300_000 : 180_000);
  await signIn(page, "en");
  await removeOwnServers(page);
  try {
    await page.goto("/settings/you/connections");
    const section = page.locator("[data-own-servers]");
    await section.getByRole("button", { name: "Add MCP server" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('[data-own-server-field="address"]').fill(`${sampleBase}/mcp`);
    await dialog.getByRole("button", { name: "Connect" }).click();

    // The server's key guard asks for a Bearer token and names no sign-in: the dialog asks for
    // the token.
    await expect(dialog.getByRole("heading", { name: "Token for 127.0.0.1" })).toBeVisible({
      timeout: 30_000
    });
    const field = dialog.locator('[data-own-token-field="token"]');
    await expect(field).toHaveAttribute("type", "password");
    await field.fill(sampleKey);
    await dialog.getByRole("button", { name: "Technical details" }).click();
    await expect(dialog.locator('[data-own-token-field="header"]')).toBeVisible();
    await shoot(page, "token");
    await dialog.getByRole("button", { name: "Set token" }).click();

    // The tools the token read.
    await expect(dialog.locator("li[data-approval-tool]")).toHaveCount(6, {
      timeout: DISCOVERY_TIMEOUT_MS
    });
    await dialog.locator('[data-own-server-field="title"]').fill("My notes");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    const card = page.locator("[data-own-server-card]");
    await expect(card).toContainText("My notes");
    await expect(card.locator('[data-own-server-state="connected"]')).toBeVisible();
    const replace = card.locator('[data-own-server-replace-token="replace"]');
    await expect(replace).toHaveText("Replace token");
    // Nothing the browser reads holds the token.
    const name = (await card.getAttribute("data-own-server-card")) ?? "";
    const detail = await page.request.get(`${apiBaseUrl}/api/v1/connections/${name}`);
    const detailText = await detail.text();
    expect(detailText).toContain('"ownToken"');
    expect(detailText).not.toContain(sampleKey);
    expect(JSON.stringify(await mine(page))).not.toContain(sampleKey);
    await shoot(page, "token-card");

    // Token ersetzen: the same field, in a dialog of its own.
    await replace.click();
    const replacing = page.getByRole("dialog", { name: "Token for My notes" });
    await replacing.locator('[data-own-token-field="token"]').fill(sampleKey);
    await shoot(page, "token-replace");
    await replacing.getByRole("button", { name: "Replace token" }).click();
    await expect(replacing).toBeHidden();
    await expect(card.locator('[data-own-server-state="connected"]')).toBeVisible();

    await card.getByRole("button", { name: "Remove" }).click();
    const confirm = page.getByRole("dialog", { name: "Remove My notes?" });
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(page.locator("[data-own-server-card]")).toHaveCount(0);
  } finally {
    await removeOwnServers(page);
  }
});

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const PROPOSE_TOOL = "platform.connections.propose";

test("de: an agent without the platform's tools proposes the person's own server in their chat, the add screen opens filled, and Fertig tells the chat", async ({
  page,
  browser,
  baseURL,
  releaseConnections: _releaseConnections,
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(shotsDir ? 300_000 : 180_000);
  const agent = `e2e_own_server_${randomUUID().slice(0, 8)}`;
  const agentUrl = `${apiBaseUrl}/api/v1/assets/agent/${agent}`;
  const adminContext = await browser.newContext({ baseURL });
  const admin = await adminContext.newPage();
  const adminIn = await requestWithOrigin(admin, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(adminIn.ok()).toBe(true);
  await routeProvider(page.context());
  await signIn(page, "de");
  await removeOwnServers(page);
  try {
    // An agent that holds no tool of the platform, available to everyone.
    const stored = await requestWithOrigin(admin, "put", agentUrl, {
      data: {
        expectedRevision: await assetBaseRevision(admin, agentUrl),
        availableIn: "all",
        config: {
          name: agent,
          displayName: `Notiz-Hilfe ${agent.slice(-8)}`,
          description: "Hilft beim Einrichten.",
          instructions: "Hilf beim Einrichten.",
          toolNames: []
        }
      }
    });
    expect(stored.ok(), await stored.text()).toBe(true);

    // A new chat of the person's own with it.
    await page.goto("/");
    await expect(page).toHaveURL(/\/w\/[^/]+/u);
    await page
      .getByRole("navigation", { name: "Hauptnavigation" })
      .getByRole("button", { name: "Agenten", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Agenten" })
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: `Notiz-Hilfe ${agent.slice(-8)}` }) })
      .getByRole("button", { name: "Chat starten" })
      .click();
    await expect(page).toHaveURL(/\/w\/[^/]+$/u);

    // Its proposal: the card in the chat, and the add screen opens beside it, filled.
    await sendToolCall(page, PROPOSE_TOOL, {
      mode: "own_server",
      connectorType: "mcp",
      title: "Meine Notizen",
      url: "https://notes.example.test/mcp"
    });
    const card = page.locator("[data-own-server-proposal]");
    await expect(card).toContainText("MCP-Server hinzufügen");
    await expect(card).toContainText("Meine Notizen");
    await expect(card).toContainText("notes.example.test");
    await expect(page).toHaveURL(/\/settings\/you\/connections/u);
    const dialog = page.getByRole("dialog");
    const address = dialog.locator('[data-own-server-field="address"]');
    await expect(address).toHaveValue("https://notes.example.test/mcp");
    // Nothing is saved before Verbinden.
    expect((await mine(page)).connections.filter((row) => row.ownServer)).toEqual([]);
    await shoot(page, "chat-proposal");

    // The person points it at the suite's server, connects, signs in and accepts its tools.
    await address.fill(`${sampleBase}/dcr/mcp`);
    await dialog.getByRole("button", { name: "Verbinden" }).click();
    await expect(dialog.locator("[data-sign-in-open]")).toBeVisible({ timeout: 30_000 });
    const opened = page.waitForEvent("popup");
    await dialog.locator("[data-sign-in-open]").click();
    await (await opened).waitForEvent("close");
    await expect(dialog.locator("li[data-approval-tool]")).toHaveCount(6, {
      timeout: DISCOVERY_TIMEOUT_MS
    });
    await expect(dialog.locator('[data-own-server-field="title"]')).toHaveValue("Meine Notizen");
    await dialog.getByRole("button", { name: "Fertig" }).click();
    await expect(dialog).toBeHidden();
    // The chat hears it from the person, every server and tool name quoted.
    // The chat hears it as the person's own message, with the tools accepted.
    await expect(
      page.getByText(
        /^Ich habe meinen MCP-Server „Meine Notizen“ hinzugefügt\. 6 Tools akzeptiert: „[^“]+“(, „[^“]+“){4} \+ 1 weitere\.$/u
      )
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-own-server-card]")).toContainText("Meine Notizen");
    await shoot(page, "chat-told");
  } finally {
    await removeOwnServers(page);
    const found = await admin.request.get(agentUrl);
    if (found.status() !== 404) {
      const removed = await requestWithOrigin(admin, "post", `${agentUrl}/delete`, {
        data: { expectedRevision: await assetRevision(admin, agentUrl) }
      });
      expect(removed.ok(), `Delete agent during cleanup: ${removed.status()}`).toBe(true);
    }
    await adminContext.close();
  }
});

test("en: a person adds their own MCP server from a catalogue tile that takes a token, and its card carries the service's mark", async ({
  page,
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(shotsDir ? 300_000 : 180_000);
  await signIn(page, "en");
  await removeOwnServers(page);
  const address = await entryAddress(page, "sample-records-token");
  const key = randomUUID() + randomUUID();
  const sample = await startSampleAt(address.origin, key);
  try {
    await page.goto("/settings/you/connections");
    const section = page.locator("[data-own-servers]");
    await section.getByRole("button", { name: "Add MCP server" }).click();
    const dialog = page.getByRole("dialog");
    const services = dialog.getByRole("group", { name: "Services" });
    await expect(services.locator("[data-own-server-entry]")).toHaveCount(2);
    await shoot(page, "entries");

    // The tile fills the address and locks it; "Other address" frees the field again.
    const field = dialog.locator('[data-own-server-field="address"]');
    await services.locator('[data-own-server-entry="sample-records-token"]').click();
    await expect(
      services.locator('[data-own-server-entry="sample-records-token"]')
    ).toHaveAttribute("aria-pressed", "true");
    await expect(field).toHaveValue(address.href);
    await expect(field).toHaveAttribute("readonly", "");
    await dialog.locator("[data-own-server-other-address]").click();
    await expect(field).toHaveValue("");
    await expect(field).not.toHaveAttribute("readonly", "");
    await services.locator('[data-own-server-entry="sample-records-token"]').click();
    await shoot(page, "entry-chosen");
    await dialog.getByRole("button", { name: "Connect" }).click();

    // A token entry goes straight to the token, with where to get one and no header to choose.
    await expect(dialog.locator("[data-own-server-token]")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator("[data-own-server-entry-help]")).toContainText(
      "Make a personal token in the sample service"
    );
    await expect(dialog.locator("[data-own-server-entry-link]")).toHaveAttribute(
      "href",
      "https://records-token.example.com/help/tokens"
    );
    await expect(dialog.locator('[data-own-token-field="header"]')).toHaveCount(0);
    await dialog.locator('[data-own-token-field="token"]').fill(key);
    await shoot(page, "entry-token");
    await dialog.getByRole("button", { name: "Set token" }).click();

    await expect(dialog.locator("li[data-approval-tool]")).toHaveCount(6, {
      timeout: DISCOVERY_TIMEOUT_MS
    });
    await expect(dialog.locator('[data-own-server-field="title"]')).toHaveValue(
      "Sample records with a token"
    );
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    const card = page.locator("[data-own-server-card]");
    await expect(card).toContainText("Sample records with a token");
    await expect(card.locator('[data-own-server-state="connected"]')).toBeVisible();
    const name = (await card.getAttribute("data-own-server-card")) ?? "";
    const row = (await mine(page)).connections.find((candidate) => candidate.name === name);
    expect(row?.service).toBe("sample-records-token");
    expect(JSON.stringify(await mine(page))).not.toContain(key);
    await shoot(page, "entry-card");
  } finally {
    await removeOwnServers(page);
    await stopSample(sample);
  }
});

test("de: an agent names a catalogue entry for the person's own server, the add screen opens at its tile, and the entry's word on a tool starts it as changing", async ({
  page,
  browser,
  baseURL,
  releaseConnections: _releaseConnections,
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(shotsDir ? 300_000 : 180_000);
  const agent = `e2e_own_entry_${randomUUID().slice(0, 8)}`;
  const agentUrl = `${apiBaseUrl}/api/v1/assets/agent/${agent}`;
  const adminContext = await browser.newContext({ baseURL });
  const admin = await adminContext.newPage();
  const adminIn = await requestWithOrigin(admin, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(adminIn.ok()).toBe(true);
  await signIn(page, "de");
  await removeOwnServers(page);
  const address = await entryAddress(page, "sample-records");
  await routeProvider(page.context(), address.origin);
  const sample = await startSampleAt(address.origin, randomUUID());
  try {
    const stored = await requestWithOrigin(admin, "put", agentUrl, {
      data: {
        expectedRevision: await assetBaseRevision(admin, agentUrl),
        availableIn: "all",
        config: {
          name: agent,
          displayName: `Dienst-Hilfe ${agent.slice(-8)}`,
          description: "Hilft beim Verbinden.",
          instructions: "Hilf beim Verbinden.",
          toolNames: []
        }
      }
    });
    expect(stored.ok(), await stored.text()).toBe(true);

    await page.goto("/");
    await expect(page).toHaveURL(/\/w\/[^/]+/u);
    await page
      .getByRole("navigation", { name: "Hauptnavigation" })
      .getByRole("button", { name: "Agenten", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Agenten" })
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: `Dienst-Hilfe ${agent.slice(-8)}` }) })
      .getByRole("button", { name: "Chat starten" })
      .click();
    await expect(page).toHaveURL(/\/w\/[^/]+$/u);

    // The agent names the entry and no address: the card carries the service's name.
    await sendToolCall(page, PROPOSE_TOOL, {
      mode: "own_server",
      connectorType: "mcp",
      ownServerEntry: "sample-records"
    });
    const card = page.locator('[data-own-server-proposal="sample-records"]');
    await expect(card).toContainText("Beispiel-Datensätze verbinden");
    await expect(page).toHaveURL(/\/settings\/you\/connections/u);
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator('[data-own-server-entry="sample-records"]')).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const field = dialog.locator('[data-own-server-field="address"]');
    await expect(field).toHaveValue(address.href);
    await expect(field).toHaveAttribute("readonly", "");
    expect((await mine(page)).connections.filter((row) => row.ownServer)).toEqual([]);
    await shoot(page, "entry-proposal");

    await dialog.getByRole("button", { name: "Verbinden" }).click();
    await expect(dialog.locator("[data-sign-in-open]")).toBeVisible({ timeout: 30_000 });
    const opened = page.waitForEvent("popup");
    await dialog.locator("[data-sign-in-open]").click();
    await (await opened).waitForEvent("close");
    await expect(dialog.locator("li[data-approval-tool]")).toHaveCount(6, {
      timeout: DISCOVERY_TIMEOUT_MS
    });
    // The server marks every tool read-only; the entry calls one changing, so it starts so,
    // unticked, and the person may set it back.
    const changing = dialog.locator('li[data-approval-tool="get_customer"]');
    await expect(changing.locator("select[data-approval-effect]")).toHaveValue("changing");
    await expect(changing.getByRole("checkbox")).not.toBeChecked();
    const reading = dialog.locator('li[data-approval-tool="list_customers"]');
    await expect(reading.getByRole("checkbox")).toBeChecked();
    await expect(dialog.locator('[data-own-server-field="title"]')).toHaveValue(
      "Beispiel-Datensätze"
    );
    await shoot(page, "entry-tools");
    await dialog.getByRole("button", { name: "Fertig" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-own-server-card]")).toContainText("Beispiel-Datensätze");
    await expect(
      page.getByText(/^Ich habe meinen MCP-Server „Beispiel-Datensätze“ hinzugefügt\./u)
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await removeOwnServers(page);
    await stopSample(sample);
    const found = await admin.request.get(agentUrl);
    if (found.status() !== 404) {
      const removed = await requestWithOrigin(admin, "post", `${agentUrl}/delete`, {
        data: { expectedRevision: await assetRevision(admin, agentUrl) }
      });
      expect(removed.ok(), `Delete agent during cleanup: ${removed.status()}`).toBe(true);
    }
    await adminContext.close();
  }
});
