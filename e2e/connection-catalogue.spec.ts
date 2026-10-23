import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Locator, Page, Request } from "@playwright/test";
import { z } from "zod";
import { availableSamplePort } from "./sample-port.mjs";
import {
  assetBaseRevision,
  assetRevision,
  readAsset,
  requestWithOrigin
} from "./request-with-origin";
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
const OAUTH_WIDTHS = [1280, 390] as const;

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

/** One picture per width; the page returns to the desktop width afterwards. */
async function shoot(
  page: Page,
  locale: Locale,
  theme: Theme,
  name: string,
  widths: readonly number[] = [1280]
): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: join(shotsDir, `connection-catalogue-${name}-${width}-${locale}-${theme}.png`),
      animations: "disabled"
    });
  }
  if (widths.at(-1) !== 1280) await page.setViewportSize({ width: 1280, height: 900 });
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

// The demo's OAuth entry (CAT-OAUTH-UI), `sample-oauth`, against the sample's REST provider. Its
// endpoints are fixed in the entry at localhost:8787, so the sample server answers there, with
// the client it issued for the part's fixed name. The UI and the API answer on two origins and
// `instance.publicUrl` is the UI's: the route plays the provider's page and hands the callback
// on to the API, as connection-sign-in.spec.ts does. Both tests make the Connection under the
// part's fixed name, one after the other.
const OAUTH_ENTRY = "sample-oauth";
const OAUTH_BASE = "http://localhost:8787";
const OAUTH_CLIENT_ID = "e2e-catalogue-client";
const OAUTH_CLIENT_SECRET = randomBytes(24).toString("base64url");
const callbackPath = `/api/v1/connections/${OAUTH_ENTRY}/oauth/callback`;
const bindingSchema = z.object({ binding: z.object({ state: z.string() }).optional() });
const agentPath = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;

test.describe("an OAuth entry", () => {
  test.describe.configure({ mode: "serial" });
  let oauthServer: ChildProcess | undefined;

  test.beforeEach(async ({ baseURL }) => {
    oauthServer = spawn(process.execPath, ["clients/demo/dist/sample-mcp-server.js"], {
      env: {
        ...process.env,
        DEMO_SAMPLE_MCP_KEY: randomBytes(24).toString("base64url"),
        HOST: "localhost",
        PORT: "8787",
        SAMPLE_OAUTH_ISSUER_BASE: OAUTH_BASE,
        SAMPLE_OAUTH_REST_CLIENT_ID: OAUTH_CLIENT_ID,
        SAMPLE_OAUTH_REST_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
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
  });

  test.afterEach(async ({ page }) => {
    await removeConnection(page, OAUTH_ENTRY);
    const server = oauthServer;
    oauthServer = undefined;
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
  });

  /** Plays the provider's page; each authorize request it saw is kept. */
  async function routeProvider(context: BrowserContext): Promise<URL[]> {
    const asked: URL[] = [];
    await context.route(`${OAUTH_BASE}/oauth-rest/authorize**`, async (route) => {
      asked.push(new URL(route.request().url()));
      const answer = await route.fetch({ maxRedirects: 0 });
      const back = new URL(answer.headers().location ?? "");
      expect(back.pathname).toBe(callbackPath);
      const landed = await context.request.get(`${apiBaseUrl}${back.pathname}${back.search}`, {
        maxRedirects: 0
      });
      expect(landed.status()).toBe(303);
      await route.fulfill({ status: 303, headers: { location: landed.headers().location ?? "" } });
    });
    return asked;
  }

  /** New connection, Dienste, the OAuth entry: its first step, with whose account to choose. */
  async function openEntry(page: Page, theme: Theme) {
    const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
      data: { ...admin, rememberMe: true }
    });
    expect(signedIn.ok()).toBe(true);
    await page.addInitScript((chosen) => {
      window.localStorage.setItem("vivd-catalyst:locale", "de");
      window.localStorage.setItem("vivd-catalyst:theme", chosen);
    }, theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/build/connections");
    const main = page.getByRole("region", { name: "Studio" });
    await main.getByRole("button", { name: WORDS.de.newConnection }).first().click();
    const dialog = page.getByRole("dialog").first();
    await dialog.locator(`[data-catalogue-entry="${OAUTH_ENTRY}"]`).getByRole("button").click();
    await expect(dialog.locator(`[data-catalogue-intro="${OAUTH_ENTRY}"]`)).toBeVisible();
    return dialog;
  }

  /** The client id and secret, then Verbinden: saved and its secret set, nothing tested. */
  async function connect(page: Page, dialog: Locator, writes: string[]) {
    const field = (name: string) => dialog.locator(`[data-connection-field="${name}"]`);
    await field("oauth.clientId").fill(OAUTH_CLIENT_ID);
    await expect(field("secret")).toHaveAttribute("type", "password");
    await field("secret").fill(OAUTH_CLIENT_SECRET);
    await dialog.locator("[data-connection-connect]").click();
    const review = page.locator("[data-catalogue-review]");
    await expect(review).toBeVisible({ timeout: 30_000 });
    expect(writes).toEqual([
      "PUT /api/v1/assets/connection/:name",
      "PUT /api/v1/connections/:name/secret"
    ]);
    // The recommended reading tool is ticked, under its group; the sign-in asks for its access.
    await expect(
      review
        .locator('[data-approval-group="read"] li[data-approval-tool="listCustomers"]')
        .getByRole("checkbox")
    ).toBeChecked();
    await expect(review.locator("[data-catalogue-scopes]")).toHaveAttribute(
      "data-catalogue-scopes",
      "sample.identity sample.read"
    );
    return review;
  }

  function recordWrites(page: Page): string[] {
    const writes: string[] = [];
    page.on("request", (request: Request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET" && path.includes(`/connection/${OAUTH_ENTRY}`)) {
        writes.push(`${request.method()} ${path.replace(OAUTH_ENTRY, ":name")}`);
      }
      if (request.method() !== "GET" && path.includes(`/connections/${OAUTH_ENTRY}/`)) {
        writes.push(`${request.method()} ${path.replace(OAUTH_ENTRY, ":name")}`);
      }
    });
    return writes;
  }

  test("de light: installed for each person's own account, approved, and given to an agent", async ({
    page,
    baseURL,
    releaseConnections: _releaseConnections,
    // The test stores an agent; the turn on the agents holds the one on the Namespaces.
    instanceAgentsChange: _instanceAgentsChange
  }) => {
    test.setTimeout(150_000);
    const tag = randomUUID().slice(0, 8);
    const agent = `e2e_catalogue_oauth_${tag}`;
    const writes = recordWrites(page);
    const dialog = await openEntry(page, "light");
    try {
      const stored = await requestWithOrigin(page, "put", agentPath(agent), {
        data: {
          expectedRevision: await assetBaseRevision(page, agentPath(agent)),
          availableIn: "all",
          config: {
            name: agent,
            displayName: `Catalogue probe ${tag}`,
            description: "Reads the sample customers.",
            instructions: "Help with the sample customers.",
            toolNames: []
          }
        }
      });
      expect(stored.ok(), await stored.text()).toBe(true);

      // Whose account: the entry's default, each person's own; no sentence on a shared one.
      await expect(dialog.locator('[data-connection-field="credentialMode"]')).toHaveAttribute(
        "data-credential-mode",
        "user"
      );
      await expect(dialog.locator("[data-catalogue-shared-note]")).toHaveCount(0);
      // The redirect URI to register: the instance's own, for the part's fixed name.
      await expect(dialog.locator("[data-catalogue-redirect-uri]")).toHaveAttribute(
        "data-catalogue-redirect-uri",
        `${baseURL}${callbackPath}`
      );
      await shoot(page, "de", "light", "oauth-install", OAUTH_WIDTHS);

      const review = await connect(page, dialog, writes);
      await shoot(page, "de", "light", "oauth-review", OAUTH_WIDTHS);
      await page.getByRole("dialog").first().locator("[data-connection-approve]").click();

      // Each person connects their own; the admin may connect theirs now.
      const done = page.getByRole("dialog").first();
      await expect(done.locator("[data-catalogue-personal]")).toBeVisible();
      await expect(done.locator("[data-catalogue-connect-own]")).toBeVisible();
      await expect(review).toHaveCount(0);
      await shoot(page, "de", "light", "oauth-personal", OAUTH_WIDTHS);
      const approved = await readAsset(
        page,
        `${apiBaseUrl}/api/v1/assets/connection/${OAUTH_ENTRY}`
      );
      expect(approved?.config).toMatchObject({
        credentialMode: "user",
        catalogue: { entry: OAUTH_ENTRY, part: "tools", version: 1 },
        settings: {
          oauth: { clientId: OAUTH_CLIENT_ID, scopes: ["sample.identity", "sample.read"] }
        }
      });
      expect(approved?.config.operations).toEqual([
        expect.objectContaining({ name: "listCustomers", enabled: true, exposure: ["agent"] })
      ]);
      expect(JSON.stringify(approved)).not.toContain(OAUTH_CLIENT_SECRET);

      // "Einem Agenten geben": the agent gets the approved tool.
      await done.locator("[data-connection-give]").click();
      await done.locator(`[data-connection-give-agent="${agent}"]`).click();
      await done.locator("[data-connection-give-next]").click();
      await done.locator("[data-connection-give-confirm]").click();
      await expect(done.locator('[data-connection-give-outcome="published"]')).toBeVisible();
      const given = await readAsset(page, agentPath(agent));
      expect(given?.config.toolNames).toEqual([`connection.${OAUTH_ENTRY}.listCustomers`]);
      await done.locator("[data-connection-give-done]").click();
      await expect(page).toHaveURL(new RegExp(`/build/connections/${OAUTH_ENTRY}$`, "u"));
    } finally {
      const found = await page.request.get(agentPath(agent));
      if (found.ok()) {
        await requestWithOrigin(page, "post", `${agentPath(agent)}/delete`, {
          data: { expectedRevision: await assetRevision(page, agentPath(agent)) }
        });
      }
    }
  });

  test("de dark: installed for one shared account, which signs in with exactly the approved access", async ({
    page,
    baseURL,
    releaseConnections: _releaseConnections
  }) => {
    test.setTimeout(150_000);
    const asked = await routeProvider(page.context());
    const writes = recordWrites(page);
    const dialog = await openEntry(page, "dark");

    // Shared: the sentence on whose account everyone reads stands before the secret.
    await dialog.locator('[data-connection-field="credentialMode"]').getByText("Geteilt").click();
    await expect(dialog.locator('[data-connection-field="credentialMode"]')).toHaveAttribute(
      "data-credential-mode",
      "shared"
    );
    await expect(dialog.locator("[data-catalogue-shared-note]")).toBeVisible();
    const checklistUri = await dialog
      .locator("[data-catalogue-redirect-uri]")
      .getAttribute("data-catalogue-redirect-uri");
    expect(checklistUri).toBe(`${baseURL}${callbackPath}`);
    await shoot(page, "de", "dark", "oauth-shared-install", OAUTH_WIDTHS);

    await connect(page, dialog, writes);
    await page.getByRole("dialog").first().locator("[data-connection-approve]").click();

    // The sign-in step: the provider's page in a tab of its own, with the approved access.
    const step = page.getByRole("dialog").first();
    await expect(step.locator('[data-sign-in-step="ready"]')).toBeVisible();
    await shoot(page, "de", "dark", "oauth-shared-sign-in", OAUTH_WIDTHS);
    const tab = page.waitForEvent("popup");
    await step.locator("[data-sign-in-open]").click();
    await (await tab).waitForEvent("close");

    // The redirect URI the sign-in sent is the one the checklist named.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.searchParams.get("redirect_uri")).toBe(checklistUri);
    expect(asked[0]?.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(asked[0]?.searchParams.get("scope")).toBe("sample.identity sample.read");

    // Signed in, the tools may be given to an agent.
    await expect(step.locator("[data-connection-approved]")).toBeVisible({ timeout: 30_000 });
    const detail = await page.request.get(`${apiBaseUrl}/api/v1/connections/${OAUTH_ENTRY}`);
    expect(detail.ok()).toBe(true);
    expect(bindingSchema.parse(await detail.json()).binding?.state).toBe("connected");
    expect(await page.content()).not.toContain(OAUTH_CLIENT_SECRET);
    await shoot(page, "de", "dark", "oauth-shared-signed-in", OAUTH_WIDTHS);
  });
});
