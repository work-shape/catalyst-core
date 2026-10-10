import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Instance > Modules: an operator reads which modules this instance runs. And a module that is
// off is off everywhere: a second API runs the same instance with `resources` off, on the same
// database, and the interface in front of it has no Resources panel and no way to it.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl = `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const configPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** The API with `resources` off listens beside the suite's own. */
const offApiPort = Number(new URL(apiBaseUrl).port) + 7;
const offApiUrl = `http://${host}:${offApiPort}`;

const conversationSchema = z.object({ id: z.string() });
const refusalSchema = z.object({
  error: z.object({
    code: z.string(),
    details: z.object({ reason: z.string(), module: z.string() })
  })
});

async function signIn(page: Page, api = apiBaseUrl): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

const moduleRow = (page: Page, name: string) => page.locator(`[data-module="${name}"]`);

test("an operator reads the modules of the instance, in English and in German", async ({
  page
}) => {
  await signIn(page);
  await page.goto("/settings/instance/modules");

  await expect(page.getByRole("heading", { name: "Modules", level: 1 })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Settings pages" })
      .getByRole("button", { name: "Modules" })
  ).toBeVisible();
  // Every module the product knows has a row, in the order of the registry.
  await expect(page.locator("[data-module]")).toHaveCount(4);
  expect(
    await page
      .locator("[data-module]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-module")))
  ).toEqual(["documents", "resources", "assetManagement", "userInvitations"]);

  const resources = moduleRow(page, "resources");
  await expect(resources).toContainText("Resources");
  await expect(resources).toContainText("On");
  await expect(resources).toContainText("Operations: 1");
  await expect(resources).toContainText("modules.resources.enabled");
  await expect(moduleRow(page, "assetManagement")).toContainText("On");
  await expect(moduleRow(page, "assetManagement")).toContainText("Operations: 5");
  // The open platform ships no code for documents, so it cannot be on here.
  const documents = moduleRow(page, "documents");
  await expect(documents).toContainText("Off");
  await expect(documents).toContainText("Not part of this build");
  await expect(documents).toContainText("modules.documents.enabled");

  // The switch is release config: the page says so and offers nothing to change.
  const main = page.getByRole("region", { name: "Settings" });
  await expect(main.locator("[data-operator-managed]")).toContainText(
    "The operator of this instance sets these in its release config."
  );
  await expect(main.getByRole("switch")).toHaveCount(0);
  await expect(main.getByRole("checkbox")).toHaveCount(0);
  await expect(main.getByRole("table").getByRole("button")).toHaveCount(0);

  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Module", level: 1 })).toBeVisible();
  await expect(moduleRow(page, "resources")).toContainText("Inhalte");
  await expect(moduleRow(page, "resources")).toContainText("An");
  await expect(moduleRow(page, "resources")).toContainText("Operationen: 1");
  await expect(moduleRow(page, "documents")).toContainText("Aus");
  await expect(moduleRow(page, "documents")).toContainText("Nicht Teil dieses Builds");
  await expect(page.locator("[data-operator-managed]")).toContainText(
    "Der Betreiber dieser Instanz legt das in der Release-Konfiguration fest."
  );
});

// No module of the open platform owns an agent tool or a job kind. The two tests below serve
// the one field an instance with such a module answers with, over the answer of the real API,
// and everything else is the product: the stored agent, the editor, the save, the job row.
// tests/module-off.test.ts holds the server's side with a module that owns both.

const exportSchema = z.object({ agents: z.array(z.record(z.string(), z.unknown())) });
const storedAgentSchema = z.object({ config: z.object({ toolNames: z.array(z.string()) }) });

test("an admin removes a tool of a module that is off from an agent and saves", async ({
  page
}) => {
  test.setTimeout(60_000);
  const staleTool = "demo.weather_forecast";
  // An agent of this test alone: other files write agents and skills while this one runs.
  const agentName = "modules_e2e_agent";
  const agentUrl = `${apiBaseUrl}/api/v1/instance/config/assets/agent/${agentName}`;
  await signIn(page);
  const exported = exportSchema.parse(
    await (await page.request.get(`${apiBaseUrl}/api/v1/instance/config/export`)).json()
  );
  const template = exported.agents.find((candidate) => candidate.name === "research_assistant");
  expect(template).toBeDefined();
  // The agent names the tool, as it did before the module was turned off.
  const stored = await requestWithOrigin(page, "put", agentUrl, {
    data: { config: { ...template, name: agentName, toolNames: [staleTool] } }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
  try {
    await page.route(
      ({ pathname }) => pathname === "/api/v1/instance/config/assets",
      async (route) => {
        const response = await route.fetch();
        const body: { references: { enabledToolNames: string[] } } = await response.json();
        await route.fulfill({
          response,
          json: {
            ...body,
            references: {
              ...body.references,
              enabledToolNames: body.references.enabledToolNames.filter(
                (name) => name !== staleTool
              ),
              moduleOffTools: [{ name: staleTool, module: "documents" }]
            }
          }
        });
      }
    );

    // The agent's page in the Build area.
    await page.goto(`/build/agents/${agentName}`);
    const form = page.locator("form");
    const tools = form.getByRole("group", { name: "Tools", exact: true });
    // The tool is not on offer, and the agent's reference to it is there to see and to remove.
    await expect(tools.getByLabel(staleTool, { exact: true })).toHaveCount(0);
    const stale = tools.locator(`[data-unavailable-option="${staleTool}"]`);
    await expect(stale).toContainText(staleTool);
    await expect(stale).toContainText(
      "Not available: the module Documents is off. Remove it to save."
    );
    await expect(tools).toContainText("1 selected");

    await stale.getByRole("button", { name: "Remove" }).click();
    await expect(stale).toHaveCount(0);
    await expect(tools).toContainText("0 selected");
    // The removal is an unsaved change: leaving the page asks first, and staying keeps it.
    const question = page.getByRole("dialog", { name: "Leave without saving?", exact: true });
    await page.getByRole("button", { name: "Back to Agents", exact: true }).click();
    await expect(question).toBeVisible();
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toBeHidden();
    await expect(stale).toHaveCount(0);
    // A write of another file between the load and the save is a conflict: the editor loads
    // the latest, and the reference is removed and saved again.
    const conflict = page.getByRole("dialog", { name: "Configuration changed on the server" });
    await expect(async () => {
      if (await conflict.isVisible()) {
        await conflict.getByRole("button", { name: "Reload latest", exact: true }).click();
        await expect(conflict).toBeHidden();
      }
      if (await stale.isVisible()) await stale.getByRole("button", { name: "Remove" }).click();
      await form.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect
        .poll(
          async () =>
            storedAgentSchema.parse(await (await page.request.get(agentUrl)).json()).config
              .toolNames,
          { timeout: 3_000 }
        )
        .toEqual([]);
    }).toPass({ timeout: 30_000 });
  } finally {
    const deleted = await requestWithOrigin(page, "post", `${agentUrl}/delete`, { data: {} });
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
});

test("a queued job of a module that is off says what it waits for", async ({ page }) => {
  const jobId = `job_e2e_waits_${randomUUID()}`;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Due in a year: no worker of the suite takes it while the test reads it.
    await sql`
      insert into platform_jobs (
        id, client_instance_id, kind, payload, status, run_after, attempts, max_attempts,
        correlation_id, created_at
      )
      select
        ${jobId}, client_instance_id, 'fixture.index_document', '{}', 'queued',
        now() + interval '1 year', 0, 1, ${`corr_${jobId}`}, now()
      from platform_jobs limit 1`;
    await signIn(page);
    await page.route(
      ({ pathname }) => pathname === "/api/v1/instance/jobs",
      async (route) => {
        const response = await route.fetch();
        const body: { items: { id: string }[] } = await response.json();
        await route.fulfill({
          response,
          json: {
            ...body,
            items: body.items.map((job) =>
              job.id === jobId ? { ...job, waitingForModule: "documents" } : job
            )
          }
        });
      }
    );

    await page.goto("/settings/instance/jobs");
    await page.getByRole("tab", { name: /^Queued/u }).click();
    const row = page.locator(`[data-job-id="${jobId}"]`);
    await expect(row).toContainText("Queued");
    await expect(row.locator("[data-waiting-for-module]")).toHaveText(
      "Waits until the module Documents is on. No worker takes it while the module is off."
    );

    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
    await page.reload();
    await page.getByRole("tab", { name: /^Wartend/u }).click();
    await expect(row.locator("[data-waiting-for-module]")).toHaveText(
      "Wartet, bis das Modul Dokumente an ist. Solange es aus ist, übernimmt kein Worker den Job."
    );
  } finally {
    await sql`delete from platform_jobs where id = ${jobId}`;
    await sql.end();
  }
});

test.describe("with the resources module off", () => {
  // The second API starts inside the first test's time.
  test.describe.configure({ timeout: 90_000 });
  let offApi: ChildProcess | undefined;

  test.beforeAll(async () => {
    // The suite's own config with the one switch turned, served by a second API process.
    const offConfigPath = resolve(dirname(resolve(configPath)), "e2e-app-resources-off.yaml");
    const config = (await readFile(configPath, "utf8")).replaceAll(apiBaseUrl, offApiUrl);
    await mkdir(dirname(offConfigPath), { recursive: true });
    await writeFile(offConfigPath, `${config}\nmodules:\n  resources:\n    enabled: false\n`);
    offApi = spawn(process.execPath, ["clients/demo/dist/server.js"], {
      env: {
        ...process.env,
        HOST: host,
        PORT: String(offApiPort),
        CLIENT_CONFIG_PATH: offConfigPath,
        DATABASE_URL: databaseUrl,
        CHAT_UI_ORIGIN: process.env.E2E_UI_URL ?? `http://${host}:5273`,
        BETTER_AUTH_URL: `${offApiUrl}/api/auth`,
        // The secret of the suite's own API: both sign the sessions of one database.
        BETTER_AUTH_SECRET: "e2e-better-auth-secret-with-at-least-32-characters",
        E2E_SUPERADMIN_EMAIL: superadmin.email,
        E2E_USER_EMAIL: "e2e-user@example.test",
        // Its own values for what the config asks every API to have. No test here uses them.
        CHAT_SESSION_TOKEN_SECRET: "e2e-modules-session-token-secret-of-24-characters",
        CHAT_SERVER_CREDENTIAL: "e2e-modules-server-credential",
        SERVICE_ACCESS_TOKEN_SECRET: "e2e-modules-service-access-token-secret-32-chars"
      },
      stdio: "inherit"
    });
    const started = offApi;
    await expect
      .poll(
        async () => {
          if (started.exitCode !== null) throw new Error("The API with resources off stopped");
          try {
            return (await fetch(`${offApiUrl}/health`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000 }
      )
      .toBe(200);
  });

  test.afterAll(async () => {
    if (!offApi || offApi.exitCode !== null) return;
    const exited = new Promise((done) => offApi?.once("exit", done));
    offApi.kill("SIGTERM");
    await exited;
  });

  test("the Resources panel, its operation and every way to it are gone", async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    await page.waitForURL(/\/w\/[^/]+$/u);
    const workspaceUrl = page.url();
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations`, {
      data: { collaborationWorkspaceId: decodeURIComponent(workspaceUrl.split("/w/")[1] ?? "") }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const conversation = conversationSchema.parse(await created.json());
    await plantResource(conversation.id);
    const conversationUrl = `${workspaceUrl}/c/${encodeURIComponent(conversation.id)}`;
    const resourcesPath = `/api/v1/conversations/${conversation.id}/resources`;

    // With the module on, the conversation shows its resource and the operation answers.
    await page.goto(conversationUrl);
    const panel = page.getByRole("button", { name: /Resources panel$/u });
    await expect(panel).toBeVisible();
    await expect(page.getByText("Planted table")).toBeVisible();
    expect((await page.request.get(`${apiBaseUrl}${resourcesPath}`)).status()).toBe(200);

    // The same interface in front of the API that runs the instance with the module off.
    await signIn(page, offApiUrl);
    await page.route(`${apiBaseUrl}/**`, (route) =>
      route.continue({ url: route.request().url().replace(apiBaseUrl, offApiUrl) })
    );
    const resourceRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/resources")) resourceRequests.push(request.url());
    });
    await page.goto(conversationUrl);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(page.getByText("Planted table")).toHaveCount(0);
    expect(resourceRequests).toEqual([]);

    // The operation is gone for a caller who asks for it by its address.
    const refused = await page.request.get(`${offApiUrl}${resourcesPath}`);
    expect(refused.status()).toBe(404);
    expect(refusalSchema.parse(await refused.json()).error).toEqual({
      code: "NOT_FOUND",
      details: { reason: "module_off", module: "resources" }
    });

    // The palette leads to the pages of this instance and to nothing of the module.
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const palette = page.getByRole("dialog", { name: "Search" });
    await expect(palette.getByRole("option", { name: "Modules", exact: true })).toBeVisible();
    await expect(palette.getByRole("option", { name: /Resources/u })).toHaveCount(0);
    await palette.getByRole("option", { name: "Modules", exact: true }).click();

    // And the Modules page says which module is off.
    await expect(page).toHaveURL(/\/settings\/instance\/modules$/u);
    await expect(moduleRow(page, "resources")).toContainText("Off");
    await expect(moduleRow(page, "assetManagement")).toContainText("On");
  });
});

/** A table the conversation holds, as a structured data tool leaves it. */
async function plantResource(conversationId: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      insert into structured_data_resources (
        id, client_instance_id, conversation_id, resource_key, title, state, revision,
        created_at, updated_at
      )
      select
        ${`sdr_e2e_${randomUUID()}`}, client_instance_id, id, 'planted', 'Planted table',
        ${sql.json({})}, 1, now(), now()
      from conversations where id = ${conversationId}`;
  } finally {
    await sql.end();
  }
}
