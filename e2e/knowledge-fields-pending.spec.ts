import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, takeTurn, test } from "./test";

// Documents of a Knowledge Base whose fields wait (PROC-2): one for the monthly budget, one over
// the token limit per document. Each stays searchable and says "Fields pending" with its reason. The suite's instance runs
// without the module `knowledge`, so a second API runs the same instance with it on, on the same
// database, as modules.spec.ts does with `resources` off. The interface is sent to it, and the
// list of documents is planted on its way to the page. Pictures go to the test's output folder
// and are attached to its report, in English and German, light and dark, wide and at 390.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const configPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** The API with `knowledge` on listens beside the suite's own. */
const knowledgeApiPort = Number(new URL(apiBaseUrl).port) + 12;
const knowledgeApiUrl = `http://${host}:${knowledgeApiPort}`;

type Locale = "en" | "de";

const WORDS: Record<
  Locale,
  { searchable: string; pending: string; reason: string; tokenReason: string }
> = {
  en: {
    searchable: "Searchable",
    pending: "Fields pending",
    reason: "Fields are filled in once the budget resets or is raised",
    tokenReason:
      "Fields wait: this document needs an estimated 184,250 input tokens plus 512 reserved output tokens, exceeding the limit of 120,000 tokens per document. Raise the limit to fill them in"
  },
  de: {
    searchable: "Durchsuchbar",
    pending: "Felder ausstehend",
    reason: "Felder werden gefüllt, sobald das Budget zurückgesetzt oder erhöht wird",
    tokenReason:
      "Felder warten: Dieses Dokument braucht geschätzt 184.250 Eingabe-Tokens plus 512 reservierte Ausgabe-Tokens und überschreitet damit die Grenze von 120.000 Tokens je Dokument. Erhöhe die Grenze, damit sie gefüllt werden"
  }
};

async function signIn(page: Page, api: string): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** The documents the page is shown: two whose fields wait, one done, one still indexed. */
function plantedDocuments() {
  const at = "2026-10-17T09:00:00.000Z";
  const document = (id: string, fileName: string, extra: Record<string, unknown>) => ({
    id,
    fileId: `file_${id}`,
    fileName,
    title: fileName,
    format: "pdf",
    bytes: 412_000,
    addedAt: at,
    updatedAt: at,
    ...extra
  });
  return {
    documents: [
      document("doc_paused", "Rechnung 2026-0412.pdf", {
        state: "indexed",
        fieldsPending: true,
        fieldsPendingReason: { reason: "monthly_budget" }
      }),
      document("doc_large", "Rahmenvertrag 2026.pdf", {
        state: "indexed",
        fieldsPending: true,
        fieldsPendingReason: {
          reason: "token_budget",
          estimatedTokens: 184_250,
          reservedOutputTokens: 512,
          maxTokensPerDocument: 120_000
        }
      }),
      document("doc_done", "Rechnung 2026-0398.pdf", { state: "indexed", fieldsPending: false }),
      document("doc_new", "Lieferschein 7781.pdf", { state: "pending" })
    ]
  };
}

test.describe("a document whose fields wait for the budget", () => {
  test.describe.configure({ mode: "serial" });
  let knowledgeApi: ChildProcess | undefined;

  test.beforeAll(async ({}, testInfo) => {
    // A hook keeps the default timeout; waiting for the turn and starting the API need more.
    testInfo.setTimeout(120_000);
    // An API that starts makes the release Connections of the shared database equal to its
    // config. It starts when no test holds a Connection it planted there.
    const started = await takeTurn("release-connections", testInfo.project.use.baseURL);
    try {
      await startKnowledgeApi();
    } finally {
      await started();
    }
  });

  async function startKnowledgeApi(): Promise<void> {
    // The suite's own config with the one switch turned, served by a second API process.
    const onConfigPath = resolve(dirname(resolve(configPath)), "e2e-app-knowledge-on.yaml");
    const config = (await readFile(configPath, "utf8")).replaceAll(apiBaseUrl, knowledgeApiUrl);
    await mkdir(dirname(onConfigPath), { recursive: true });
    const section = /^modules:\n/mu;
    expect(section.test(config)).toBe(true);
    await writeFile(
      onConfigPath,
      config.replace(section, "modules:\n  knowledge:\n    enabled: true\n")
    );
    knowledgeApi = spawn(process.execPath, ["clients/demo/dist/e2e-server.js"], {
      env: {
        ...process.env,
        HOST: host,
        PORT: String(knowledgeApiPort),
        CLIENT_CONFIG_PATH: onConfigPath,
        DATABASE_URL: databaseUrl,
        // One database, so one queue of jobs and Agent Runs: this API takes none of them.
        E2E_TAKES_NO_JOBS: "1",
        CHAT_UI_ORIGIN: process.env.E2E_UI_URL ?? `http://${host}:5273`,
        BETTER_AUTH_URL: `${knowledgeApiUrl}/api/auth`,
        // The secret of the suite's own API: both sign the sessions of one database.
        BETTER_AUTH_SECRET: "e2e-better-auth-secret-with-at-least-32-characters",
        E2E_SUPERADMIN_EMAIL: superadmin.email,
        E2E_USER_EMAIL: "e2e-user@example.test",
        CHAT_SESSION_TOKEN_SECRET: "e2e-knowledge-session-token-secret-of-24-chars",
        CHAT_SERVER_CREDENTIAL: "e2e-knowledge-server-credential",
        SERVICE_ACCESS_TOKEN_SECRET: "e2e-knowledge-service-access-token-secret-32-ch"
      },
      stdio: "inherit"
    });
    const started = knowledgeApi;
    await expect
      .poll(
        async () => {
          if (started.exitCode !== null) throw new Error("The API with knowledge on stopped");
          try {
            return (await fetch(`${knowledgeApiUrl}/health`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000 }
      )
      .toBe(200);
  }

  test.afterAll(async () => {
    if (!knowledgeApi || knowledgeApi.exitCode !== null) return;
    const exited = new Promise((done) => knowledgeApi?.once("exit", done));
    knowledgeApi.kill("SIGTERM");
    await exited;
  });

  test("stays searchable and says its fields are pending, in both languages and themes", async ({
    page
  }) => {
    test.setTimeout(180_000);
    const name = `e2e-fields-pending-${randomUUID().slice(0, 8)}`;
    const assetUrl = `${knowledgeApiUrl}/api/v1/assets/knowledge_base/${name}`;
    await signIn(page, apiBaseUrl);
    await signIn(page, knowledgeApiUrl);

    const created = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        config: {
          name,
          title: "Eingangsrechnungen",
          description: "Rechnungen unserer Lieferanten mit Rechnungsnummer, Datum und Betrag.",
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

      // The interface talks to the API with the module on; its list of documents is planted.
      // A later route is asked first, so the planted list stands in front of the redirect.
      await page.route(`${apiBaseUrl}/**`, (route) =>
        route.continue({ url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl) })
      );
      const documentsPath = `/api/v1/knowledge-bases/${name}/documents`;
      await page.route(
        (url) => url.pathname === documentsPath,
        (route) =>
          route.request().method() === "GET"
            ? route.fulfill({ json: plantedDocuments() })
            : route.fallback()
      );

      const section = page.locator("[data-knowledge-documents]");
      const paused = section.locator('[data-knowledge-document="doc_paused"]');
      const large = section.locator('[data-knowledge-document="doc_large"]');
      for (const locale of ["en", "de"] as const) {
        const words = WORDS[locale];
        for (const theme of ["light", "dark"] as const) {
          for (const width of [1280, 390] as const) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            await page.emulateMedia({ colorScheme: theme });
            await page.goto(`/build/knowledge-bases/${name}`);
            await page.evaluate(
              (view) => {
                window.localStorage.setItem("vivd-catalyst:locale", view.locale);
                window.localStorage.setItem("vivd-catalyst:theme", view.theme);
              },
              { locale, theme }
            );
            await page.reload();
            await expect(
              page.getByRole("heading", { name: "Eingangsrechnungen", level: 1 })
            ).toBeVisible();
            await expect(paused).toBeVisible();

            // Searchable, with the pause beside the state and its reason in the status line.
            await expect(paused).toContainText(words.searchable);
            await expect(paused).toContainText(words.pending);
            await expect(paused).toContainText(words.reason);
            await expect(paused).not.toContainText("fieldsPending");
            // Over the token limit: both numbers in the locale's format, and what to do.
            await expect(large).toContainText(words.searchable);
            await expect(large).toContainText(words.pending);
            await expect(large).toContainText(words.tokenReason);
            await expect(large).not.toContainText(words.reason);
            await expect(large).not.toContainText("token_budget");
            await expect(section.locator('[data-knowledge-document="doc_done"]')).not.toContainText(
              words.pending
            );
            await expect(section.locator('[data-knowledge-document="doc_new"]')).not.toContainText(
              words.pending
            );
            // At 390 the row fits the window: nothing scrolls sideways.
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth
            );
            expect(overflow).toBeLessThanOrEqual(0);

            await section.scrollIntoViewIfNeeded();
            const label = `${locale}-${theme}-${width}`;
            const path = test.info().outputPath(`evidence-knowledge-fields-pending-${label}.png`);
            await page.screenshot({ path, animations: "disabled" });
            await test.info().attach(`knowledge-fields-pending-${label}`, {
              path,
              contentType: "image/png"
            });
          }
        }
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
