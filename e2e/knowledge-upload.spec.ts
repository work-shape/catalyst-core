import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { chooseAddDocuments, openKnowledgeSettings } from "./knowledge-page";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, takeTurn, test } from "./test";

// Uploading files from the person's computer into a Knowledge Base (ACCEPT-FIX-1, F1): three
// text files chosen in the Add dialog become documents, are indexed, and the test search on the
// page finds each of them. The suite's instance runs without the module `knowledge`, so a second
// API runs the same instance with it on, on the same database. Its worker claims jobs through
// the same leases as the main API, with the same tools and config plus knowledge indexing.
const host = process.env.E2E_HOST ?? "127.0.0.1";

const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;

const configPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

/** The API with `knowledge` on listens beside the suite's own, on a port no other spec takes. */
const knowledgeApiPort = Number(new URL(apiBaseUrl).port) + 13;

const knowledgeApiUrl = `http://${host}:${knowledgeApiPort}`;

/** The three files, each with a word only it holds. */
const FILES = [
  {
    name: "urlaub.txt",
    mimeType: "text/plain",
    text: "Urlaubstage: Jede Mitarbeiterin und jeder Mitarbeiter hat 28 Urlaubstage im Jahr.",
    word: "Urlaubstage"
  },
  {
    name: "reisen.md",
    mimeType: "text/markdown",
    text: "# Reisekosten\n\nBahnfahrten werden in der zweiten Klasse erstattet.",
    word: "Bahnfahrten"
  },
  {
    name: "support.txt",
    mimeType: "text/plain",
    text: "Die Hotline des Supports ist werktags von 8 bis 18 Uhr erreichbar.",
    word: "Hotline"
  }
] as const;

async function signIn(page: Page, api: string): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test.describe("uploading files from the computer into a Knowledge Base", () => {
  test.describe.configure({ mode: "serial" });
  const processes: ChildProcess[] = [];
  test.beforeAll(async ({}, testInfo) => {
    // A hook keeps the default timeout; waiting for the turn and starting the API need more.
    testInfo.setTimeout(120000);
    // An API that starts makes the release Connections of the shared database equal to its
    // config. It starts when no test holds a Connection it planted there.
    const started = await takeTurn("release-connections", testInfo.project.use.baseURL);
    try {
      await startKnowledge();
    } finally {
      await started();
    }
  });
  async function startKnowledge(): Promise<void> {
    const onConfigPath = resolve(dirname(resolve(configPath)), "e2e-app-knowledge-upload.yaml");
    const config = (await readFile(configPath, "utf8")).replaceAll(apiBaseUrl, knowledgeApiUrl);
    await mkdir(dirname(onConfigPath), { recursive: true });
    const section = /^modules:\n/mu;
    expect(section.test(config)).toBe(true);
    await writeFile(
      onConfigPath,
      config.replace(section, "modules:\n  knowledge:\n    enabled: true\n")
    );
    const env = {
      ...process.env,
      HOST: host,
      PORT: String(knowledgeApiPort),
      CLIENT_CONFIG_PATH: onConfigPath,
      DATABASE_URL: databaseUrl,
      CHAT_UI_ORIGIN: process.env.E2E_UI_URL ?? `http://${host}:5273`,
      BETTER_AUTH_URL: `${knowledgeApiUrl}/api/auth`,
      // The secret of the suite's own API: both sign the sessions of one database.
      BETTER_AUTH_SECRET: "e2e-better-auth-secret-with-at-least-32-characters",
      E2E_SUPERADMIN_EMAIL: superadmin.email,
      E2E_USER_EMAIL: "e2e-user@example.test",
      CHAT_SESSION_TOKEN_SECRET:
        process.env.CHAT_SESSION_TOKEN_SECRET ??
        "e2e-session-token-secret-with-at-least-24-characters",
      CHAT_SERVER_CREDENTIAL:
        process.env.CHAT_SERVER_CREDENTIAL ?? "e2e-server-to-server-credential",
      SERVICE_ACCESS_TOKEN_SECRET:
        process.env.SERVICE_ACCESS_TOKEN_SECRET ??
        "e2e-service-access-token-secret-with-32-characters"
    };
    // This API has the same tools and capabilities as the suite's main API. Its leased
    // worker may serve the same jobs and additionally indexes Knowledge Base documents.
    const api = spawn(process.execPath, ["clients/demo/dist/e2e-server.js"], {
      env,
      stdio: "inherit"
    });
    processes.push(api);
    await expect
      .poll(
        async () => {
          if (api.exitCode !== null) throw new Error("The API with knowledge on stopped");
          try {
            return (await fetch(`${knowledgeApiUrl}/health`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 60000 }
      )
      .toBe(200);
  }
  test.afterAll(async () => {
    await Promise.all(
      processes.map(async (child) => {
        if (child.exitCode !== null) return;
        const exited = new Promise((done) => child.once("exit", done));
        child.kill("SIGTERM");
        await exited;
      })
    );
  });
  test("adds three text files from the computer and the test search finds each", async ({
    page
  }) => {
    test.setTimeout(240000);
    const name = `e2e-upload-${randomUUID().slice(0, 8)}`;
    const assetUrl = `${knowledgeApiUrl}/api/v1/assets/knowledge_base/${name}`;
    await signIn(page, apiBaseUrl);
    await signIn(page, knowledgeApiUrl);
    const created = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        config: {
          name,
          title: "Handbuch",
          description: "Regeln des Teams zu Urlaub, Reisen und Support.",
          methods: ["keyword"]
        }
      }
    });
    expect(created.ok(), await created.text()).toBe(true);
    try {
      const published = await requestWithOrigin(page, "post", `${assetUrl}/publish`, {
        data: { revision: 1 }
      });
      expect(published.ok(), await published.text()).toBe(true);
      // Its store is made by the suite's own worker; the documents are listed once it stands.
      await expect
        .poll(
          async () =>
            (
              await page.request.get(`${knowledgeApiUrl}/api/v1/knowledge-bases/${name}/documents`)
            ).status(),
          { timeout: 90000 }
        )
        .toBe(200);
      // The interface talks to the API with the module on.
      await page.route(`${apiBaseUrl}/**`, (route) =>
        route.continue({ url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl) })
      );
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/build/knowledge-bases/${name}`);
      await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
      await page.reload();
      await expect(page.getByRole("heading", { name: "Handbuch", level: 1 })).toBeVisible();
      await chooseAddDocuments(page, "files");
      const upload = page.locator("[data-knowledge-upload]");
      await upload.locator("input[data-file-picker]").setInputFiles(
        FILES.map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          buffer: Buffer.from(file.text)
        }))
      );
      for (const file of FILES) {
        await expect(upload.locator(`[data-knowledge-upload-file="${file.name}"]`)).toHaveAttribute(
          "data-knowledge-upload-state",
          "added",
          { timeout: 30000 }
        );
      }
      await page.locator("[data-knowledge-add-close]").click();
      // Each file is a document of the Knowledge Base, indexed by the worker.
      const documents = page.locator("[data-knowledge-documents]");
      await expect(documents.locator('[data-knowledge-document-state="indexed"]')).toHaveCount(
        FILES.length,
        { timeout: 120000 }
      );
      // The test search on the page finds each file by the word only it holds.
      await openKnowledgeSettings(page);
      const search = page.locator("[data-knowledge-test-search]");
      for (const file of FILES) {
        await search.getByRole("searchbox").fill(file.word);
        await search.getByRole("button", { name: "Search" }).click();
        const passages = search.locator("[data-knowledge-search-passages]");
        await expect(passages.locator("[data-knowledge-passage]").first()).toContainText(file.name);
      }
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      // Deleted where its kind is known: the suite's own API runs without the module.
      if ((await page.request.get(assetUrl)).ok()) {
        await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
          data: { expectedRevision: await assetRevision(page, assetUrl) }
        });
      }
    }
  });
});
