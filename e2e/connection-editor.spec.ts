import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Page, Request } from "@playwright/test";
import { availableSamplePort } from "./sample-port.mjs";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { openOwnConnection } from "./connection-page";
// The New connection dialog against the demo's sample MCP server, which this file starts on
// a free loopback port the suite's `egress.allow` permits: a wrong address, then a refused key,
// then the tools the server names, approved in one confirmation. The key is typed and never
// shown again.
const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
let sampleBase: string;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** How long the instance may take to read the tools: the discovery is a job. */
const DISCOVERY_TIMEOUT_MS = 45000;
let sampleServer: ChildProcess | undefined;
const sampleKey = randomBytes(24).toString("base64url");
// Connections and the sample server's port are instance-wide. Keep the same turn as the
// list/rights specs through setup, every UI write and cleanup, including parallel repeats.
test.beforeEach(async ({ releaseConnections: _releaseConnections }) => {});
test.beforeAll(async () => {
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
      { timeout: 15000 }
    )
    .toBe(200);
});
test.afterAll(async () => {
  const server = sampleServer;
  sampleServer = undefined;
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
});
/** Signs in and opens the dialog in English, light. */
async function openDialog(page: Page) {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "en");
    window.localStorage.setItem("vivd-catalyst:theme", "light");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/build/connections");
  const main = page.getByRole("region", { name: "Studio" });
  await main.getByRole("button", { name: "New connection" }).first().click();
  await expect(page.getByRole("dialog", { name: "New connection" })).toBeVisible();
  return { main, dialog: page.getByRole("dialog").first() };
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
test("an MCP server is connected after a wrong address and a refused key, and its tools are approved at once", async ({
  page
}) => {
  test.setTimeout(150000);
  const id = `e2e-mcp-${randomUUID().slice(0, 8)}`;
  const writes = recordWrites(page, id);
  const { main, dialog } = await openDialog(page);
  try {
    await openOwnConnection(dialog);
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
    // Nobody answers at that address: the address says so, and the key stays.
    await connect.click();
    await expect(field("url")).toHaveAttribute("aria-invalid", "true");
    await expect(field("secret")).toHaveValue("not-the-key");
    // The server answers and refuses the key: the field is empty and waits for another.
    await field("url").fill(`${sampleBase}/mcp`);
    await connect.click();
    await expect(field("secret")).toHaveAttribute("aria-invalid", "true");
    await expect(field("secret")).toHaveValue("");
    // The right key: the steps run while the test is slow, then the server's tools. The route
    // holds this one test and then removes itself: an unroute while it holds the request would
    // let Playwright continue it first, and the handler's own continue would throw.
    let releaseTest = () => {};
    const testReleased = new Promise<void>((resolve) => (releaseTest = resolve));
    await page.route(
      "**/api/v1/connections/*/test",
      async (route) => {
        await testReleased;
        await route.continue();
      },
      { times: 1 }
    );
    await field("secret").fill(sampleKey);
    await connect.click();
    await expect(dialog.locator('[data-connect-step="server"]')).toBeVisible();
    releaseTest();
    const tools = dialog.locator("li[data-approval-tool]");
    await expect(tools).toHaveCount(6, { timeout: DISCOVERY_TIMEOUT_MS });
    await expect(dialog.locator("[data-connection-connected]")).toBeVisible();
    // Every tool of the sample says it only reads: all are ticked, for agents.
    await expect(tools.getByRole("checkbox", { checked: true })).toHaveCount(6);
    await expect(dialog.locator('[data-approval-surface="agent"]')).toBeChecked();
    await expect(dialog.locator('[data-approval-surface="workflow"]')).not.toBeChecked();
    await tools.nth(4).getByRole("checkbox").uncheck();
    await tools.nth(5).getByRole("checkbox").uncheck();
    await dialog.locator('[data-approval-surface="workflow"]').check();
    await expect(dialog.locator("[data-approval-count]")).toContainText("4");
    const approved = await tools.evaluateAll((rows) =>
      rows.slice(0, 4).map((row) => row.getAttribute("data-approval-tool") ?? "")
    );
    await dialog.locator("[data-connection-approve]").click();
    // Approved for agents, the dialog offers the give to an agent (CS-5d); Done leaves it.
    await expect(dialog.locator("[data-connection-approved]")).toContainText("4");
    await expect(dialog.locator("[data-connection-give]")).toBeVisible();
    await dialog.locator("[data-connection-approved-done]").click();
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
