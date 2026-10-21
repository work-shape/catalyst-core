import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Request } from "@playwright/test";
import { availableSamplePort } from "./sample-port.mjs";
import { assetRevision, readAsset, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The Connection Catalogue in New connection (CAT-1): "Dienste" with the demo's sample entry,
// which the suite's config names, and the suite's folder entry, which it does not and which is
// greyed. The sample entry is installed against the demo's sample server, started on a free
// loopback port: its checklist and the sentence on the shared account, the key, Verbinden,
// then the review with the two recommended reading tools ticked and the third not. Only the
// approval enables them. In English, and in German light and dark at 1280.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** Set to a directory to keep pictures of each step. */
const shotsDir = process.env.E2E_SHOTS_DIR;

type Locale = "en" | "de";
type Theme = "light" | "dark";
const WORDS: Record<Locale, { newConnection: string; services: string; title: string }> = {
  en: { newConnection: "New connection", services: "Services", title: "Sample accounting" },
  de: { newConnection: "Neue Verbindung", services: "Dienste", title: "Beispielbuchhaltung" }
};

let sampleServer: ChildProcess | undefined;
let sampleBase: string;
const sampleKey = randomBytes(24).toString("base64url");

// Connections and the sample server's port are instance-wide: keep the turn of the other
// Connection specs.
test.beforeEach(async ({ releaseConnections: _releaseConnections }) => {
  const samplePort = await availableSamplePort(
    (process.env.E2E_SAMPLE_MCP_PORTS ?? "4219").split(",").map(Number)
  );
  sampleBase = `http://127.0.0.1:${samplePort}`;
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

async function shoot(page: Page, locale: Locale, theme: Theme, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({
    path: join(shotsDir, `connection-catalogue-${name}-1280-${locale}-${theme}.png`),
    animations: "disabled"
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

for (const [locale, theme] of [
  ["en", "light"],
  ["de", "light"],
  ["de", "dark"]
] as const) {
  test(`${locale} ${theme}: a catalogue entry is installed, and only the approval enables its tools`, async ({
    page
  }) => {
    const id = `e2e-catalogue-${locale}-${theme}-${randomUUID().slice(0, 8)}`;
    const writes: string[] = [];
    page.on("request", (request: Request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET" && path.includes(`/${id}`)) {
        writes.push(`${request.method()} ${path.replace(id, ":name")}`);
      }
    });
    const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
      data: { ...admin, rememberMe: true }
    });
    expect(signedIn.ok()).toBe(true);
    await page.addInitScript(
      ([chosenLocale, chosenTheme]) => {
        window.localStorage.setItem("vivd-catalyst:locale", chosenLocale);
        window.localStorage.setItem("vivd-catalyst:theme", chosenTheme);
      },
      [locale, theme] as const
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    try {
      await page.goto("/build/connections");
      const main = page.getByRole("region", { name: "Studio" });
      await main.getByRole("button", { name: WORDS[locale].newConnection }).first().click();
      const dialog = page.getByRole("dialog").first();

      // Dienste: the named entry to choose, the other greyed with no button.
      const services = dialog.locator("[data-connection-services]");
      await expect(services).toContainText(WORDS[locale].services);
      const offered = services.locator('[data-catalogue-entry="sample-accounting"]');
      const greyed = services.locator('[data-catalogue-entry="sample-files"]');
      await expect(offered).toHaveAttribute("data-catalogue-offered", "true");
      await expect(offered.locator('[data-service-mark-tile="initial"]')).toBeVisible();
      await expect(greyed).toHaveAttribute("data-catalogue-offered", "false");
      await expect(greyed.locator("[data-catalogue-not-offered]")).toBeVisible();
      await expect(greyed.getByRole("button")).toHaveCount(0);
      // An own MCP server or REST API stays beside the entries.
      await expect(dialog.locator('[data-connection-type="http_api"]')).toBeVisible();
      await shoot(page, locale, theme, "services");

      // The part's step: what it does, its checklist, the fields with their defaults.
      await offered.getByRole("button").click();
      await expect(dialog.locator('[data-catalogue-intro="sample-accounting"]')).toBeVisible();
      await expect(dialog.locator("[data-catalogue-checklist]")).toBeVisible();
      await shoot(page, locale, theme, "install-intro");
      const field = (name: string) => dialog.locator(`[data-connection-field="${name}"]`);
      await expect(field("baseUrl")).toHaveValue("http://sample-mcp:8787/rest");
      await expect(field("headers.x-client-instance-id")).toHaveValue("demo-local");
      await dialog.locator("[data-name-with-address-fold]").click();
      await dialog.locator('[data-name-with-address-field="address"]').fill(id);
      await field("baseUrl").fill(`${sampleBase}/rest`);
      await expect(field("secret")).toHaveAttribute("type", "password");
      await field("secret").fill(sampleKey);
      // The sentence on the shared account stands before the key.
      const note = dialog.locator("[data-catalogue-shared-note]");
      await expect(note).toBeVisible();
      expect(
        await note.evaluate(
          (element, secret) =>
            Boolean(
              secret && element.compareDocumentPosition(secret) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
          await field("secret").elementHandle()
        )
      ).toBe(true);
      await shoot(page, locale, theme, "install");

      // Verbinden writes the Connection with no operation, then the review.
      await dialog.locator("[data-connection-connect]").click();
      const review = page.locator("[data-catalogue-review]");
      await expect(review).toBeVisible({ timeout: 30_000 });
      const stored = await readAsset(page, `${apiBaseUrl}/api/v1/assets/connection/${id}`);
      expect(stored?.config).toMatchObject({
        service: "sample-accounting",
        catalogue: { entry: "sample-accounting", part: "tools", version: 1 },
        operations: []
      });
      const tool = (name: string) =>
        review.locator(`li[data-approval-tool="${name}"]`).getByRole("checkbox");
      await expect(tool("listClients")).toBeChecked();
      await expect(tool("listFiscalYears")).toBeChecked();
      await expect(tool("listAccountPostings")).not.toBeChecked();
      await shoot(page, locale, theme, "review");

      const reviewDialog = page.getByRole("dialog").first();
      await reviewDialog.locator("[data-connection-approve]").click();
      // With agents to give the tools to, the step says so; Fertig opens the Connection.
      await reviewDialog.locator("[data-connection-approved-done]").click();
      await expect(page).toHaveURL(new RegExp(`/build/connections/${id}$`, "u"));
      // The Connection's page has read the Connection and shows its state. Read later, after the
      // cleanup's delete, it would be answered 404.
      await expect(page.locator("[data-connection-health]")).toBeVisible();

      const approved = await readAsset(page, `${apiBaseUrl}/api/v1/assets/connection/${id}`);
      expect(approved?.config).toMatchObject({
        catalogue: { entry: "sample-accounting", part: "tools", version: 1 }
      });
      expect(approved?.config.operations).toEqual([
        expect.objectContaining({ name: "listClients", enabled: true, exposure: ["agent"] }),
        expect.objectContaining({ name: "listFiscalYears", enabled: true, exposure: ["agent"] })
      ]);
      expect(JSON.stringify(approved)).not.toContain(sampleKey);
      expect(writes).toEqual([
        "PUT /api/v1/assets/connection/:name",
        "PUT /api/v1/connections/:name/secret",
        "POST /api/v1/connections/:name/test",
        "PUT /api/v1/assets/connection/:name"
      ]);
    } finally {
      await removeConnection(page, id);
    }
  });
}
