import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, Request } from "@playwright/test";
import { availableSamplePort } from "./sample-port.mjs";
import { sendToolCall } from "./page-surface-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The New connection dialog against the demo's sample MCP server, which this file starts on
// a free loopback port the suite's `egress.allow` permits. An MCP server: a wrong address, then a refused
// key, then the tools the server names, approved in one confirmation. A REST API: the address,
// the key and the test path, then tools pasted as YAML and approved. Each in English and in
// German; the key is typed and never shown again. The agent's draft of a REST API's tools
// (CS-5c): a card in the chat whose button opens the approval list, on the Connection's page or
// in the New connection dialog, and nothing is saved before the person approves.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
let sampleBase: string;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** Set to a directory to keep pictures of each step of the dialog and of the page. */
const shotsDir = process.env.E2E_SHOTS_DIR;
/** How long the instance may take to read the tools: the discovery is a job. */
const DISCOVERY_TIMEOUT_MS = 45_000;

const LOCALES = ["en", "de"] as const;
type Locale = (typeof LOCALES)[number];
/** The few words a locator needs where no data attribute names the thing. */
const WORDS: Record<Locale, { newConnection: string; discard: string; draft: string }> = {
  en: { newConnection: "New connection", discard: "Discard", draft: "Draft read-only tools" },
  de: { newConnection: "Neue Verbindung", discard: "Verwerfen", draft: "Entwirf Lese-Tools" }
};

let sampleServer: ChildProcess | undefined;
const sampleKey = randomBytes(24).toString("base64url");

// Connections and the sample server's port are instance-wide. Keep the same turn as the
// list/rights specs through setup, every UI write and cleanup, including parallel repeats.
test.beforeEach(async ({ releaseConnections: _releaseConnections }) => {
  // A killed worker can leave its child alive. Never reuse that child's port and key.
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

/** Pictures of what stands now, light, at 1280 and at 390; the page is not reloaded. */
async function shoot(page: Page, locale: Locale, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: join(shotsDir, `connection-create-${name}-${width}-${locale}-light.png`)
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Signs in and opens the dialog in the locale, light. */
async function openDialog(page: Page, locale: Locale) {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript((chosen) => {
    window.localStorage.setItem("vivd-catalyst:locale", chosen);
    window.localStorage.setItem("vivd-catalyst:theme", "light");
  }, locale);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/build/connections");
  const main = page.getByRole("region", { name: "Studio" });
  await main.getByRole("button", { name: WORDS[locale].newConnection }).first().click();
  // The title of the dialog follows its step; its first step is "New connection".
  await expect(page.getByRole("dialog", { name: WORDS[locale].newConnection })).toBeVisible();
  const dialog = page.getByRole("dialog").first();
  await expect(dialog.locator("[data-connection-type]")).toHaveCount(2);
  return { main, dialog };
}

/** The writes the browser sends about one Connection, in their order. */
function recordWrites(page: Page, id: string): string[] {
  const writes: string[] = [];
  page.on("request", (request: Request) => {
    if (request.method() === "GET") return;
    const path = new URL(request.url()).pathname;
    if (!path.includes(`/${id}`)) return;
    writes.push(`${request.method()} ${path.replace(id, ":name")}`);
  });
  return writes;
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

for (const locale of LOCALES) {
  test(`${locale}: an MCP server is connected after a wrong address and a refused key, and its tools are approved at once`, async ({
    page
  }) => {
    test.setTimeout(150_000);
    const id = `e2e-mcp-${locale}-${randomUUID().slice(0, 8)}`;
    const writes = recordWrites(page, id);
    const { main, dialog } = await openDialog(page, locale);
    try {
      await shoot(page, locale, "pick");
      await dialog.locator('[data-connection-type="mcp"]').getByRole("button").click();

      const field = (name: string) => dialog.locator(`[data-connection-field="${name}"]`);
      const connect = dialog.locator("[data-connection-connect]");
      await expect(connect).toBeDisabled();
      await dialog.locator('[data-name-with-address-field="name"]').fill("Sample on the suite");
      await dialog.locator("[data-name-with-address-fold]").click();
      await dialog.locator('[data-name-with-address-field="address"]').fill(id);
      await field("url").fill(`${sampleBase}/nope`);
      await expect(field("secret")).toHaveAttribute("type", "password");
      await field("secret").fill("not-the-key");
      await shoot(page, locale, "mcp-form");

      // Nobody answers at that address: the address says so, and the key stays.
      await connect.click();
      await expect(field("url")).toHaveAttribute("aria-invalid", "true");
      await expect(field("secret")).toHaveValue("not-the-key");
      await shoot(page, locale, "mcp-error-url");

      // The server answers and refuses the key: the field is empty and waits for another.
      await field("url").fill(`${sampleBase}/mcp`);
      await connect.click();
      await expect(field("secret")).toHaveAttribute("aria-invalid", "true");
      await expect(field("secret")).toHaveValue("");
      await shoot(page, locale, "mcp-error-key");

      // The right key: the steps run while the test is slow, then the server's tools. The route
      // holds this one test and then removes itself: an unroute while it holds the request would
      // let Playwright continue it first, and the handler's own continue would throw.
      await page.route(
        "**/api/v1/connections/*/test",
        async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          await route.continue();
        },
        { times: 1 }
      );
      await field("secret").fill(sampleKey);
      await connect.click();
      await expect(dialog.locator('[data-connect-step="server"]')).toBeVisible();
      await shoot(page, locale, "mcp-connecting");

      const tools = dialog.locator("li[data-approval-tool]");
      await expect(tools).toHaveCount(6, { timeout: DISCOVERY_TIMEOUT_MS });
      await expect(dialog.locator("[data-connection-connected]")).toBeVisible();
      // Every tool of the sample says it only reads: all are ticked, for agents.
      await expect(tools.getByRole("checkbox", { checked: true })).toHaveCount(6);
      await expect(dialog.locator('[data-approval-surface="agent"]')).toBeChecked();
      await expect(dialog.locator('[data-approval-surface="workflow"]')).not.toBeChecked();
      await shoot(page, locale, "mcp-approve");

      await tools.nth(4).getByRole("checkbox").uncheck();
      await tools.nth(5).getByRole("checkbox").uncheck();
      await dialog.locator('[data-approval-surface="workflow"]').check();
      await expect(dialog.locator("[data-approval-count]")).toContainText("4");
      const approved = await tools.evaluateAll((rows) =>
        rows.slice(0, 4).map((row) => row.getAttribute("data-approval-tool") ?? "")
      );
      await dialog.locator("[data-connection-approve]").click();

      // One write with the four approved; the page holds them and offers the two others.
      await expect(page).toHaveURL(new RegExp(`/build/connections/${id}$`, "u"));
      await expect(dialog).toHaveCount(0);
      await expect(main.locator("[data-connection-operation]")).toHaveCount(4);
      for (const name of approved) {
        await expect(main.locator(`[data-connection-exposure="workflow:${name}"]`)).toBeChecked();
      }
      await expect(main.locator("[data-connection-discovered] li[data-approval-tool]")).toHaveCount(
        2
      );
      await shoot(page, locale, "mcp-page");

      // Each connect writes the definition and tests it. The key goes along the first time and
      // after it was refused, not after the path changed on the same host.
      expect(writes).toEqual([
        "PUT /api/v1/assets/connection/:name",
        "PUT /api/v1/connections/:name/secret",
        "POST /api/v1/connections/:name/test",
        "PUT /api/v1/assets/connection/:name",
        "POST /api/v1/connections/:name/test",
        "PUT /api/v1/assets/connection/:name",
        "PUT /api/v1/connections/:name/secret",
        "POST /api/v1/connections/:name/test",
        "POST /api/v1/connections/:name/discover",
        "PUT /api/v1/assets/connection/:name"
      ]);
      expect(await page.content()).not.toContain(sampleKey);
    } finally {
      await removeConnection(page, id);
    }
  });

  test(`${locale}: a REST API is connected, its tools are pasted and approved, and Workshaper is asked for more`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const id = `e2e-rest-${locale}-${randomUUID().slice(0, 8)}`;
    const writes = recordWrites(page, id);
    const { main, dialog } = await openDialog(page, locale);
    try {
      await dialog.locator('[data-connection-type="http_api"]').getByRole("button").click();
      const field = (name: string) => dialog.locator(`[data-connection-field="${name}"]`);
      await dialog.locator('[data-name-with-address-field="name"]').fill("Exampledata");
      await field("url").fill(sampleBase);
      await field("secret").fill(sampleKey);
      await dialog.locator("[data-name-with-address-fold]").click();
      await dialog.locator('[data-name-with-address-field="address"]').fill(id);
      await field("headers").getByRole("button").last().click();
      await field("headers").locator("input").nth(0).fill("x-e2e");
      await field("headers").locator("input").nth(1).fill("catalyst");
      await field("testPath").fill("/healthz");
      await shoot(page, locale, "rest-form");
      await dialog.locator("[data-connection-connect]").click();

      // Connected, it names no tools: pasted, they reach the approval list.
      await expect(dialog.locator("[data-connection-add-tools]")).toBeVisible();
      await expect(dialog.locator("[data-connection-connected]")).toBeVisible();
      await shoot(page, locale, "rest-add");
      await dialog.locator("[data-connection-paste]").getByRole("button").click();
      await dialog
        .locator("[data-connection-paste-field]")
        .fill(
          [
            "- name: health",
            "  description: Says whether the service runs.",
            "  method: GET",
            "  path: /healthz",
            `  query: ${JSON.stringify(enumQuery)}`
          ].join("\n")
        );
      await shoot(page, locale, "rest-paste");
      await dialog.locator("[data-connection-paste-check]").click();
      const row = dialog.locator('li[data-approval-tool="health"]');
      await expect(row).toContainText("GET /healthz");
      await expect(row.getByRole("checkbox")).toBeChecked();
      await checkParameterEnums(row, locale);
      await shoot(page, locale, "rest-approve");
      await dialog.locator("[data-connection-approve]").click();

      await expect(page).toHaveURL(new RegExp(`/build/connections/${id}$`, "u"));
      await expect(main.locator('[data-connection-operation="health"]')).toBeVisible();
      await expect(main.locator("[data-connection-add-tools]")).toBeVisible();
      await shoot(page, locale, "rest-page");
      expect(writes).toEqual([
        "PUT /api/v1/assets/connection/:name",
        "PUT /api/v1/connections/:name/secret",
        "POST /api/v1/connections/:name/test",
        "PUT /api/v1/assets/connection/:name"
      ]);

      // "Draft with Workshaper" opens the chat beside the page with the request typed.
      await main.locator("[data-connection-draft]").getByRole("button").click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.activeElement instanceof HTMLTextAreaElement
              ? document.activeElement.value
              : ""
          )
        )
        .toContain(WORDS[locale].draft);
      await shoot(page, locale, "rest-draft");
      expect(await page.content()).not.toContain(sampleKey);
    } finally {
      await removeConnection(page, id);
    }
  });
}

test("cancel after a failed connect asks, then deletes the Connection", async ({ page }) => {
  test.setTimeout(90_000);
  const id = `e2e-discard-${randomUUID().slice(0, 8)}`;
  const { dialog } = await openDialog(page, "en");
  try {
    await dialog.locator('[data-connection-type="http_api"]').getByRole("button").click();
    const field = (name: string) => dialog.locator(`[data-connection-field="${name}"]`);
    await dialog.locator('[data-name-with-address-field="name"]').fill("Nowhere");
    await field("url").fill(`${sampleBase}/nope`);
    await dialog.locator("[data-name-with-address-fold]").click();
    await dialog.locator('[data-name-with-address-field="address"]').fill(id);
    await field("testPath").fill("/nothing");
    await dialog.locator("[data-connection-connect]").click();
    await expect(field("url")).toHaveAttribute("aria-invalid", "true");
    expect((await page.request.get(`${apiBaseUrl}/api/v1/connections/${id}`)).ok()).toBe(true);

    await page.keyboard.press("Escape");
    const ask = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Discard/u }));
    await ask.getByRole("button", { name: WORDS.en.discard, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(async () => (await page.request.get(`${apiBaseUrl}/api/v1/connections/${id}`)).status())
      .toBe(404);
  } finally {
    await removeConnection(page, id);
  }
});

/** The draft the agent answers for the Connection `id`: the sample server's health, read. */
/** The title the agent drafts with; an existing Connection keeps its own. */
const DRAFT_TITLE = "Sample API";
/** The title of the Connection the draft is for on its page. */
const EXISTING_TITLE = "Sample health service";
/** A description longer than the three lines the approval list shows before "Show more". */
const LONG_DESCRIPTION = [
  "Reads the status of the sample service: whether it runs, since when, and which version it serves.",
  "Call it before any other tool of this Connection when a person asks whether the service is reachable,",
  "and again after an error, to tell an outage of the service from a refused request.",
  "It reads only and changes nothing; it takes no parameter and answers in a few milliseconds."
].join(" ");

/** Ordinary multi-value enums, including text that must never become an element or link. */
const ENUM_TEXT = '<img data-enum-injection src=x onerror="alert(1)"> [open](javascript:alert(2))';
const LONG_ENUM_VALUE =
  "A detailed report category for the service's regional availability history. ".repeat(12);
const enumQuery = {
  status: { schema: { type: "string", enum: ["ready", ENUM_TEXT] } },
  report: { schema: { type: "string", enum: ["overview", LONG_ENUM_VALUE] } }
};

/** Both paste and draft must show values, keep markup inert, and unfold the long value. */
async function checkParameterEnums(row: Locator, locale: Locale): Promise<void> {
  const status = row.locator('[data-approval-parameter="query.status"]');
  await expect(status).toContainText("ready");
  await expect(status).toContainText(ENUM_TEXT);
  await expect(row.locator("img, a, [data-enum-injection]")).toHaveCount(0);
  const report = row.locator('[data-approval-parameter="query.report"]');
  await expect(report).toContainText("overview");
  const more = report.locator("[data-approval-enum]").getByRole("button");
  await expect(more).toHaveText(showMore[locale]);
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const value = report.locator("[data-approval-enum] > span").first();
  await expect(value).toHaveText(`overview\n${LONG_ENUM_VALUE}`);
  await expect(value).not.toHaveClass(/line-clamp-3/u);
  // Fold it again so the short values and the fold control fit together in the screenshots.
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "false");
}

function healthDraft(id: string) {
  return {
    connection: id,
    title: DRAFT_TITLE,
    baseUrl: sampleBase,
    headerNames: ["x-e2e"],
    operations: [
      {
        name: "health",
        title: "Health",
        description: "Says whether the service runs.",
        method: "GET",
        path: "/healthz",
        query: enumQuery,
        effect: "reading"
      },
      {
        name: "status",
        title: "Status",
        description: LONG_DESCRIPTION,
        method: "GET",
        path: "/healthz",
        effect: "reading"
      }
    ]
  };
}

/** The control that unfolds a long description. */
const showMore: Record<Locale, string> = { en: "Show more", de: "Mehr anzeigen" };

/** Pictures of what stands now, light and dark, at 1280 and at 390; the page is not reloaded. */
async function shootModes(page: Page, locale: Locale, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const mode of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (name === "enum") {
        // Keep both enum sets inside the approval dialog's scrollport at each width.
        const row = page.getByRole("dialog").locator('li[data-approval-tool="health"]');
        const first = row.locator('[data-approval-parameter="query.status"]');
        const last = row.locator('[data-approval-parameter="query.report"]');
        await last.scrollIntoViewIfNeeded();
        await expect(first).toBeInViewport({ ratio: 1 });
        await expect(last).toBeInViewport({ ratio: 1 });
        await expect(last.getByRole("button", { name: showMore[locale] })).toBeVisible();
      }
      await page.screenshot({
        path: join(shotsDir, `connection-draft-${name}-${width}-${locale}-${mode}.png`),
        animations: "disabled"
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

for (const locale of LOCALES) {
  test(`${locale}: the agent's draft is a card that opens the approval list, and only the approval saves it`, async ({
    page
  }) => {
    test.setTimeout(150_000);
    const existing = `e2e-draft-${locale}-${randomUUID().slice(0, 8)}`;
    const fresh = `e2e-draft-new-${locale}-${randomUUID().slice(0, 8)}`;
    const existingWrites = recordWrites(page, existing);
    const freshWrites = recordWrites(page, fresh);
    const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
      data: { ...admin, rememberMe: true }
    });
    expect(signedIn.ok()).toBe(true);
    await page.addInitScript((chosen) => {
      window.localStorage.setItem("vivd-catalyst:locale", chosen);
    }, locale);
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 900 });
    const created = await requestWithOrigin(
      page,
      "put",
      `${apiBaseUrl}/api/v1/assets/connection/${existing}`,
      {
        data: {
          expectedRevision: null,
          config: {
            name: existing,
            displayName: EXISTING_TITLE,
            connectorType: "http_api",
            settings: { baseUrl: sampleBase, testPath: "/healthz" },
            authScheme: "none",
            operations: []
          }
        }
      }
    );
    expect(created.ok()).toBe(true);
    try {
      await page.goto(`/build/connections/${existing}`);
      const main = page.getByRole("region", { name: "Studio" });
      // "Draft with Workshaper" opens the chat beside the page; the agent answers a card.
      await main.locator("[data-connection-draft]").getByRole("button").click();
      await sendToolCall(page, "platform.connections.draft_tools", healthDraft(existing));
      const card = page.locator(
        `[data-testid="connection-draft-card"][data-connection="${existing}"]`
      );
      await expect(card.locator('[data-connection-draft-tool="health"]')).toHaveText("Health");
      // The card names the existing Connection by its own title, never by the agent's.
      await expect(card).toContainText(EXISTING_TITLE);
      await expect(card).not.toContainText(DRAFT_TITLE);
      await shootModes(page, locale, "card");

      // The button opens the approval list on the page, with what each tool tells an agent.
      // Discarding it saves nothing.
      await card.locator("[data-connection-draft-open]").click();
      const dialog = page.getByRole("dialog");
      const health = dialog.locator('li[data-approval-tool="health"]');
      await expect(health).toContainText("GET /healthz");
      await expect(health.locator("[data-approval-description]")).toHaveText(
        "Says whether the service runs."
      );
      await expect(dialog.locator("[data-connection-drafted]")).toContainText(EXISTING_TITLE);
      await expect(dialog.locator("[data-connection-drafted]")).not.toContainText(DRAFT_TITLE);
      await checkParameterEnums(health, locale);
      await shootModes(page, locale, "enum");
      const status = dialog.locator('li[data-approval-tool="status"]');
      const more = status.getByRole("button", { name: showMore[locale] });
      await expect(more).toBeVisible();
      await shootModes(page, locale, "approve");
      await more.click();
      await expect(status.locator("[data-approval-description]")).toContainText(
        "answers in a few milliseconds."
      );
      await shootModes(page, locale, "approve-unfolded");
      await dialog.locator("[data-connection-discard]").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(main.locator('[data-connection-operation="health"]')).toHaveCount(0);
      expect(existingWrites).toEqual([]);

      // Opened again and approved, the one approval is the one save.
      await card.locator("[data-connection-draft-open]").click();
      await dialog.locator("[data-connection-approve]").click();
      await expect(main.locator('[data-connection-operation="health"]')).toBeVisible();
      expect(existingWrites).toEqual(["PUT /api/v1/assets/connection/:name"]);

      // For an id no Connection has, the New connection dialog opens filled, without a key.
      await sendToolCall(page, "platform.connections.draft_tools", healthDraft(fresh));
      await page
        .locator(`[data-testid="connection-draft-card"][data-connection="${fresh}"]`)
        .locator("[data-connection-draft-open]")
        .click();
      const create = page.getByRole("dialog");
      await expect(create.locator('[data-connection-create-form="http_api"]')).toBeVisible();
      const field = (name: string) => create.locator(`[data-connection-field="${name}"]`);
      await expect(create.locator('[data-name-with-address-field="name"]')).toHaveValue(
        DRAFT_TITLE
      );
      await expect(field("url")).toHaveValue(sampleBase);
      await expect(create.locator('[data-name-with-address-field="address"]')).toHaveValue(fresh);
      await expect(field("secret")).toHaveValue("");
      await expect(field("headers").locator("input").nth(0)).toHaveValue("x-e2e");
      await field("headers").locator("input").nth(1).fill("catalyst");
      await field("testPath").fill("/healthz");
      await shootModes(page, locale, "new-form");
      expect(freshWrites).toEqual([]);

      // Connected, the drafted tools wait in the approval list; approving them saves them.
      await create.locator("[data-connection-connect]").click();
      await expect(create.locator('li[data-approval-tool="health"]')).toBeVisible();
      await shootModes(page, locale, "new-approve");
      expect(freshWrites).toEqual([
        "PUT /api/v1/assets/connection/:name",
        "POST /api/v1/connections/:name/test"
      ]);
      await create.locator("[data-connection-approve]").click();
      // The chat beside the page stays open: its conversation is in the address.
      await expect(page).toHaveURL(new RegExp(`/build/connections/${fresh}(?:\\?|$)`, "u"));
      await expect(main.locator('[data-connection-operation="health"]')).toBeVisible();
      expect(freshWrites).toEqual([
        "PUT /api/v1/assets/connection/:name",
        "POST /api/v1/connections/:name/test",
        "PUT /api/v1/assets/connection/:name"
      ]);
    } finally {
      await removeConnection(page, existing);
      await removeConnection(page, fresh);
    }
  });
}
