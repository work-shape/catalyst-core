import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { chooseAddDocuments, openKnowledgeSettings } from "./knowledge-page";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, takeTurn, test } from "./test";

// Pictures of the page of a published Knowledge Base of documents, for a person to look at: its
// lead line, the line that counts its documents, the list and the folded Settings, in German,
// light and dark, at 1280. It runs only with KB_PAGE_SHOTS=1 and writes to test-results/kb-page.
// The suite's instance runs without the module `knowledge`, so a second API runs it with the
// module on, on the same database, as knowledge-upload.spec.ts does.
const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const configPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

/** The API with `knowledge` on listens beside the suite's own, on a port no other spec takes. */
const knowledgeApiPort = Number(new URL(apiBaseUrl).port) + 31;
const knowledgeApiUrl = `http://${host}:${knowledgeApiPort}`;

const SHOTS = resolve("test-results/kb-page");
const TITLE = "Teamhandbuch";

const FILES = [
  ["urlaub.txt", "Jede Mitarbeiterin und jeder Mitarbeiter hat 28 Urlaubstage im Jahr."],
  ["reisekosten.md", "# Reisekosten\n\nBahnfahrten werden in der zweiten Klasse erstattet."],
  ["support-zeiten.txt", "Die Hotline des Supports ist werktags von 8 bis 18 Uhr erreichbar."],
  ["onboarding.md", "# Onboarding\n\nIn der ersten Woche begleitet dich eine Patin."],
  ["homeoffice.txt", "Homeoffice ist an bis zu drei Tagen in der Woche möglich."],
  ["krankmeldung.txt", "Eine Krankmeldung geht am ersten Tag bis 9 Uhr an das Team."],
  ["weiterbildung.md", "# Weiterbildung\n\nJede Person hat fünf Tage Weiterbildung im Jahr."],
  ["it-sicherheit.txt", "Passwörter stehen im Passwortmanager und nirgends sonst."]
] as const;

async function signIn(page: Page, api: string): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** Opens the page in German and one theme, and waits for its documents. */
async function view(page: Page, name: string, theme: "light" | "dark"): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/build/knowledge-bases/${name}`);
  await page.evaluate((chosen) => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    window.localStorage.setItem("vivd-catalyst:theme", chosen);
  }, theme);
  await page.reload();
  await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
  await expect(page.locator("[data-knowledge-document]")).toHaveCount(FILES.length);
}

/**
 * The whole page in one picture. The content scrolls inside the page, not the window, so the
 * window is made as tall as the content first.
 */
async function picture(page: Page, label: string): Promise<void> {
  const extra = await page.locator("[data-knowledge-documents]").evaluate((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const overflowY = getComputedStyle(parent).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        return parent.scrollHeight - parent.clientHeight;
      }
    }
    return 0;
  });
  await page.setViewportSize({ width: 1280, height: 900 + Math.max(0, extra) });
  await page.screenshot({
    path: resolve(SHOTS, `kb-page-${label}.png`),
    fullPage: true,
    animations: "disabled"
  });
}

test.describe("pictures of the page of a Knowledge Base of documents", () => {
  test.skip(process.env.KB_PAGE_SHOTS !== "1", "Runs only with KB_PAGE_SHOTS=1.");
  const processes: ChildProcess[] = [];
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(120000);
    // An API that starts makes the release Connections of the shared database equal to its
    // config. It starts when no test holds a Connection it planted there.
    const started = await takeTurn("release-connections", testInfo.project.use.baseURL);
    try {
      const onConfigPath = resolve(dirname(resolve(configPath)), "e2e-app-knowledge-screens.yaml");
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
    } finally {
      await started();
    }
  });
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

  test("de: the page with eight documents, light and dark, and with Settings unfolded", async ({
    page
  }) => {
    test.setTimeout(300000);
    const name = `e2e-screens-${randomUUID().slice(0, 8)}`;
    const assetUrl = `${knowledgeApiUrl}/api/v1/assets/knowledge_base/${name}`;
    await mkdir(SHOTS, { recursive: true });
    await signIn(page, apiBaseUrl);
    await signIn(page, knowledgeApiUrl);
    const created = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        config: {
          name,
          title: TITLE,
          description:
            "Regeln des Teams zu Urlaub, Reisen, Homeoffice und Support, je Thema eine Datei.",
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
      await page.addInitScript(() => {
        window.localStorage.setItem("vivd-catalyst:locale", "de");
      });
      await page.goto(`/build/knowledge-bases/${name}`);
      await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
      await chooseAddDocuments(page, "files");
      const upload = page.locator("[data-knowledge-upload]");
      await upload.locator("input[data-file-picker]").setInputFiles(
        FILES.map(([fileName, text]) => ({
          name: fileName,
          mimeType: fileName.endsWith(".md") ? "text/markdown" : "text/plain",
          buffer: Buffer.from(text)
        }))
      );
      await expect(upload.locator('[data-knowledge-upload-state="added"]')).toHaveCount(
        FILES.length,
        { timeout: 60000 }
      );
      await page.locator("[data-knowledge-add-close]").click();
      await expect(page.locator('[data-knowledge-document-state="indexed"]')).toHaveCount(
        FILES.length,
        { timeout: 120000 }
      );

      for (const theme of ["light", "dark"] as const) {
        await view(page, name, theme);
        await picture(page, `de-${theme}`);
      }
      await view(page, name, "light");
      await openKnowledgeSettings(page);
      await picture(page, "de-light-settings");
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
