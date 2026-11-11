import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { z } from "zod";
import { availableSamplePort } from "./sample-port.mjs";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

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
    z.object({ name: z.string(), ownServer: z.object({ tools: z.number() }).optional() })
  ),
  ownServers: z.object({ mayAdd: z.boolean() }).optional()
});
const settingsSchema = z.object({
  items: z.array(z.object({ operation: z.string(), value: z.string().optional() }))
});

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
