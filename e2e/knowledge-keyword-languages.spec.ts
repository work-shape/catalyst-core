import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, takeTurn, test } from "./test";

// KB-12: the keyword languages of a Knowledge Base, in its Advanced section. One that lists
// none shows German and English checked. Choosing French instead of English saves
// `indexing.languages: [de, fr]` to the draft, the page reads it back, and the last language
// checked cannot be cleared. In German. The suite's instance runs without the module
// `knowledge`, so a second API runs it with the module on, on the same database, as
// knowledge-upload.spec.ts does.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const configPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

/** The API with `knowledge` on listens beside the suite's own, on a port no other spec takes. */
const knowledgeApiPort = Number(new URL(apiBaseUrl).port) + 29;
const knowledgeApiUrl = `http://${host}:${knowledgeApiPort}`;

const draftSchema = z.object({
  config: z.object({ indexing: z.object({ languages: z.array(z.string()) }).optional() })
});

async function signIn(page: Page, api: string): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test.describe("the keyword languages of a Knowledge Base", () => {
  test.describe.configure({ mode: "serial" });
  const processes: ChildProcess[] = [];
  test.beforeAll(async ({}, testInfo) => {
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
    const onConfigPath = resolve(dirname(resolve(configPath)), "e2e-app-keyword-languages.yaml");
    const config = (await readFile(configPath, "utf8")).replaceAll(apiBaseUrl, knowledgeApiUrl);
    await mkdir(dirname(onConfigPath), { recursive: true });
    const section = /^modules:\n/mu;
    expect(section.test(config)).toBe(true);
    await writeFile(
      onConfigPath,
      config.replace(section, "modules:\n  knowledge:\n    enabled: true\n")
    );
    const api = spawn(process.execPath, ["clients/demo/dist/e2e-server.js"], {
      env: {
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
      },
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

  test("de: chooses French instead of English in Advanced and saves it to the draft", async ({
    page
  }) => {
    test.setTimeout(150000);
    const name = `e2e-languages-${randomUUID().slice(0, 8)}`;
    const assetUrl = `${knowledgeApiUrl}/api/v1/assets/knowledge_base/${name}`;
    await signIn(page, apiBaseUrl);
    await signIn(page, knowledgeApiUrl);
    const created = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        config: {
          name,
          title: "Pressearchiv",
          description: "Artikel aus deutschen und französischen Zeitungen.",
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
      await page.addInitScript(() => {
        window.localStorage.setItem("vivd-catalyst:locale", "de");
        window.localStorage.setItem("vivd-catalyst:theme", "light");
      });
      await page.route(`${apiBaseUrl}/**`, (route) =>
        route.continue({ url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl) })
      );
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`/build/knowledge-bases/${name}`);
      await expect(page.getByRole("heading", { name: "Pressearchiv", level: 1 })).toBeVisible();

      // Listing none, it has German and English.
      const advanced = page.locator('[id="advanced"]');
      await advanced.scrollIntoViewIfNeeded();
      await expect(advanced).toContainText("Sprachen der Wortsuche");
      const box = (label: string) => advanced.getByRole("checkbox", { name: label, exact: true });
      await expect(box("Deutsch")).toBeChecked();
      await expect(box("Englisch")).toBeChecked();
      await expect(box("Französisch")).not.toBeChecked();

      await box("Englisch").click();
      await box("Französisch").click();
      await expect(box("Englisch")).not.toBeChecked();
      await expect(box("Französisch")).toBeChecked();
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname === `/api/v1/assets/knowledge_base/${name}`
      );
      await page.getByRole("button", { name: "Änderungen speichern", exact: true }).click();
      const answer = await saved;
      expect(answer.ok(), `${answer.status()} ${await answer.text()}`).toBe(true);
      const draft = draftSchema.parse(await (await page.request.get(assetUrl)).json());
      expect(draft.config.indexing?.languages).toEqual(["de", "fr"]);
      await advanced.scrollIntoViewIfNeeded();
      const shots = process.env.E2E_SHOTS_DIR;
      const path = shots
        ? `${shots}/kb-12-keyword-languages-de-light-1280.png`
        : test.info().outputPath("kb-12-keyword-languages-de-light-1280.png");
      await advanced.screenshot({ path, animations: "disabled" });

      // Read back as saved; the last language checked cannot be cleared.
      await page.reload();
      await advanced.scrollIntoViewIfNeeded();
      await expect(box("Deutsch")).toBeChecked();
      await expect(box("Französisch")).toBeChecked();
      await expect(box("Englisch")).not.toBeChecked();
      await box("Französisch").click();
      await expect(box("Deutsch")).toBeChecked();
      await expect(box("Deutsch")).toBeDisabled();
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      if ((await page.request.get(assetUrl)).ok()) {
        await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
          data: { expectedRevision: await assetRevision(page, assetUrl) }
        });
      }
    }
  });
});
