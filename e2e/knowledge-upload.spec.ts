import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, takeTurn, test } from "./test";

// Uploading files from the person's computer into a Knowledge Base (ACCEPT-FIX-1, F1): three
// text files chosen in the Add dialog become documents, are indexed, and the test search on the
// page finds each of them. The suite's instance runs without the module `knowledge`, so a second
// API runs the same instance with it on, on the same database, as knowledge-fields-pending.spec.ts
// does. Its worker claims jobs through the same leases as the main API, with the same tools
// and config plus knowledge indexing. Pictures of the upload section go to the
// test's output folder, in English and German, light and dark, wide and at 390.

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

type Locale = "en" | "de";

const WORDS: Record<Locale, { title: string; added: string; refused: string; search: string }> = {
  en: {
    title: "Upload from your computer",
    added: "Added",
    refused: "Knowledge bases here do not read this format.",
    search: "Search"
  },
  de: {
    title: "Von deinem Computer hochladen",
    added: "Hinzugefügt",
    refused: "Wissensbasen lesen dieses Format hier nicht.",
    search: "Suchen"
  }
};

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

async function view(page: Page, name: string, locale: Locale, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/build/knowledge-bases/${name}`);
  await page.evaluate(
    (chosen) => {
      window.localStorage.setItem("vivd-catalyst:locale", chosen.locale);
      window.localStorage.setItem("vivd-catalyst:theme", chosen.theme);
    },
    { locale, theme }
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Handbuch", level: 1 })).toBeVisible();
}

async function picture(page: Page, label: string) {
  const path = test.info().outputPath(`knowledge-upload-${label}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await test.info().attach(`knowledge-upload-${label}`, { path, contentType: "image/png" });
}

test.describe("uploading files from the computer into a Knowledge Base", () => {
  test.describe.configure({ mode: "serial" });
  const processes: ChildProcess[] = [];

  test.beforeAll(async ({}, testInfo) => {
    // A hook keeps the default timeout; waiting for the turn and starting the API need more.
    testInfo.setTimeout(120_000);
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
        { timeout: 60_000 }
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

  test("accepts the address generated for a multiword Knowledge Base name", async ({ page }) => {
    await signIn(page, apiBaseUrl);
    await signIn(page, knowledgeApiUrl);
    await page.route(`${apiBaseUrl}/**`, (route) =>
      route.continue({ url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl) })
    );
    try {
      await page.goto("/build/knowledge-bases");
      await page.getByRole("button", { name: "New knowledge base", exact: true }).first().click();
      const dialog = page.getByRole("dialog");
      const checked = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/assets/knowledge_base/check-name") &&
          (response.request().postData()?.includes("accept-nordlicht-wissen") ?? false)
      );
      await dialog.locator('[data-name-with-address-field="name"]').fill("ACCEPT Nordlicht Wissen");
      const response = await checked;
      expect(response.ok()).toBe(true);
      expect(await response.json()).toMatchObject({ available: true });
      await expect(dialog.getByRole("button", { name: "Advanced", exact: true })).toHaveAttribute(
        "aria-expanded",
        "false"
      );
      await dialog.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "ACCEPT Nordlicht Wissen", level: 1 })
      ).toBeVisible();
      await picture(page, "generated-address-en-light-1280");
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("de: a new Knowledge Base of documents is live at create, and one of tables in draft shows one notice (KB-PAGE-1)", async ({
    page
  }) => {
    test.setTimeout(150_000);
    const suffix = randomUUID().slice(0, 8);
    const title = `Handbuch ${suffix}`;
    const name = `handbuch-${suffix}`;
    const tablesName = `e2e-tables-${suffix}`;
    const storeName = `e2e-tables-store-${suffix}`;
    const assetUrl = `${knowledgeApiUrl}/api/v1/assets/knowledge_base/${name}`;
    const tablesUrl = `${knowledgeApiUrl}/api/v1/assets/knowledge_base/${tablesName}`;
    const storeUrl = `${knowledgeApiUrl}/api/v1/assets/data_store/${storeName}`;
    await signIn(page, apiBaseUrl);
    await signIn(page, knowledgeApiUrl);
    await page.addInitScript(() => {
      window.localStorage.setItem("vivd-catalyst:locale", "de");
      window.localStorage.setItem("vivd-catalyst:theme", "light");
    });
    await page.route(`${apiBaseUrl}/**`, (route) =>
      route.continue({ url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl) })
    );
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/build/knowledge-bases");
      await page.getByRole("button", { name: "Neue Wissensbasis", exact: true }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.locator('[data-name-with-address-field="name"]').fill(title);
      await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
      await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
      await expect(
        page.getByText("Ist sofort veröffentlicht und in keinem Arbeitsbereich verfügbar")
      ).toBeVisible();
      await page.getByLabel("Was sie enthält").fill("Regeln des Teams zu Urlaub und Reisen.");
      await page.getByRole("button", { name: "Wissensbasis anlegen", exact: true }).click();
      // Published in the same step: its Documents section is there, with no notice and no draft.
      await expect(page.locator("[data-knowledge-documents]")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("[data-knowledge-not-published]")).toHaveCount(0);
      for (const section of ["status", "test"]) {
        await expect(page.locator(`[id="${section}"]`)).toBeVisible();
      }
      const asset = await page.request.get(assetUrl);
      expect(await asset.json()).toMatchObject({ publishedRevision: 1 });
      await expect(page.locator("[data-knowledge-source-types]")).toBeVisible();
      await picture(page, "kb-page-1-new-de-light-1280");
      await page.locator('[id="documents"]').scrollIntoViewIfNeeded();
      await picture(page, "kb-page-1-new-documents-de-light-1280");

      // One of tables, saved as a draft: one notice under the head instead of three empty sections.
      const store = await requestWithOrigin(page, "put", storeUrl, {
        data: {
          expectedRevision: null,
          files: [
            { path: "store.yaml", text: `id: ${storeName}\nname: Buchungen\n` },
            {
              path: "migrations/0001_init.sql",
              text: "create table bookings (id text primary key, amount numeric not null);"
            }
          ]
        }
      });
      expect(store.ok(), await store.text()).toBe(true);
      const storePublished = await requestWithOrigin(page, "post", `${storeUrl}/publish`, {
        data: { revision: 1 }
      });
      expect(storePublished.ok(), await storePublished.text()).toBe(true);
      await expect
        .poll(
          async () =>
            (
              await page.request.get(`${knowledgeApiUrl}/api/v1/data-stores/${storeName}/describe`)
            ).status(),
          { timeout: 30_000 }
        )
        .toBe(200);
      const tables = await requestWithOrigin(page, "put", tablesUrl, {
        data: {
          expectedRevision: null,
          config: {
            name: tablesName,
            title: "Buchungsprüfung",
            description: "Was die monatliche Prüfung der Buchungen fand.",
            methods: ["structured"],
            backend: { dataStore: storeName },
            tables: [{ name: "bookings", description: "Eine Zeile je Buchung." }]
          }
        }
      });
      expect(tables.ok(), await tables.text()).toBe(true);
      await page.goto(`/build/knowledge-bases/${tablesName}`);
      await expect(page.getByRole("heading", { name: "Buchungsprüfung", level: 1 })).toBeVisible();
      const notice = page.locator("[data-knowledge-not-published]");
      await expect(notice).toContainText("Noch nicht veröffentlicht.");
      for (const section of ["documents", "status", "test"]) {
        await expect(page.locator(`[id="${section}"]`)).toHaveCount(0);
      }
      await expect(page.locator('[id="source"]')).toBeVisible();
      await picture(page, "kb-page-1-tables-draft-de-light-1280");
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      for (const url of [assetUrl, tablesUrl, storeUrl]) {
        if ((await page.request.get(url)).ok()) {
          await requestWithOrigin(page, "post", `${url}/delete`, {
            data: { expectedRevision: await assetRevision(page, url) }
          });
        }
      }
    }
  });

  test("opens a Knowledge Base right after its publish without a SQL error, and lists it once its store stands (ACCEPT-FIX-8, E7)", async ({
    page
  }) => {
    test.setTimeout(150_000);
    const name = `e2e-fresh-${randomUUID().slice(0, 8)}`;
    const assetUrl = `${knowledgeApiUrl}/api/v1/assets/knowledge_base/${name}`;
    await signIn(page, apiBaseUrl);
    await signIn(page, knowledgeApiUrl);
    // Whatever the page shows at any moment, not only at the end: the raw error of a missing
    // documents table, and the notice that the store is being made.
    await page.addInitScript(() => {
      window.localStorage.setItem("vivd-catalyst:locale", "en");
      window.localStorage.setItem("vivd-catalyst:theme", "light");
      const seen = { sqlState: false, preparing: false };
      Object.assign(window, { knowledgeFreshSeen: seen });
      new MutationObserver(() => {
        if (document.body?.innerText.includes("SQLSTATE")) seen.sqlState = true;
        if (document.querySelector("[data-knowledge-documents-preparing]")) seen.preparing = true;
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    const created = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        config: {
          name,
          title: "Handbuch",
          description: "Staff handbook for the first view after publishing",
          methods: ["keyword"]
        }
      }
    });
    expect(created.ok(), await created.text()).toBe(true);
    try {
      await page.route(`${apiBaseUrl}/**`, (route) =>
        route.continue({ url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl) })
      );
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
      const published = await requestWithOrigin(page, "post", `${assetUrl}/publish`, {
        data: { revision: 1 }
      });
      expect(published.ok(), await published.text()).toBe(true);
      // At once, before its store stands: no wait for the documents to be readable.
      await page.goto(`/build/knowledge-bases/${name}`);
      await expect(page.getByRole("heading", { name: "Handbuch", level: 1 })).toBeVisible();
      const documents = page.locator("[data-knowledge-documents]");
      await expect(documents).toBeVisible();
      await picture(page, "fresh-publish-en-light-1280");
      // The list comes by itself once the store stands, without a reload or Try again.
      await expect(documents).toContainText(
        "No documents yet. Upload files from your computer or add files from your conversations.",
        { timeout: 90_000 }
      );
      await expect(page.locator("[data-knowledge-documents-preparing]")).toHaveCount(0);
      const seen = await page.evaluate(() =>
        "knowledgeFreshSeen" in window ? window.knowledgeFreshSeen : undefined
      );
      expect(seen).toMatchObject({ sqlState: false });
      test.info().annotations.push({
        type: "store",
        description: JSON.stringify(seen)
      });
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      if ((await page.request.get(assetUrl)).ok()) {
        await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
          data: { expectedRevision: await assetRevision(page, assetUrl) }
        });
      }
    }
  });

  test("adds three text files from the computer and the test search finds each", async ({
    page
  }) => {
    test.setTimeout(240_000);
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
          { timeout: 90_000 }
        )
        .toBe(200);

      // The interface talks to the API with the module on.
      await page.route(`${apiBaseUrl}/**`, (route) =>
        route.continue({ url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl) })
      );

      await page.setViewportSize({ width: 1280, height: 900 });
      await view(page, name, "en", "light");
      await page.locator("[data-knowledge-add]").click();
      const upload = page.locator("[data-knowledge-upload]");
      await expect(upload).toContainText(WORDS.en.title);
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
          { timeout: 30_000 }
        );
        await expect(upload.locator(`[data-knowledge-upload-file="${file.name}"]`)).toContainText(
          WORDS.en.added
        );
      }
      await expect(upload.locator("[data-knowledge-upload-retry]")).toHaveCount(0);
      await picture(page, "added-en-light-1280");
      await page.locator("[data-knowledge-add-close]").click();

      // Each file is a document of the Knowledge Base, indexed by the worker.
      const documents = page.locator("[data-knowledge-documents]");
      for (const file of FILES) {
        await expect(documents).toContainText(file.name.replace(/\.[^.]+$/u, ""));
      }
      await expect(documents.locator('[data-knowledge-document-state="indexed"]')).toHaveCount(
        FILES.length,
        { timeout: 120_000 }
      );

      // The test search on the page finds each file by the word only it holds.
      const search = page.locator("[data-knowledge-test-search]");
      for (const file of FILES) {
        await search.getByRole("searchbox").fill(file.word);
        await search.getByRole("button", { name: WORDS.en.search }).click();
        const passages = search.locator("[data-knowledge-search-passages]");
        await expect(passages).toBeVisible();
        await expect(passages.locator("[data-knowledge-passage]").first()).toContainText(file.name);
      }
      await search.scrollIntoViewIfNeeded();
      await picture(page, "search-en-light-1280");

      // The section in both languages, themes and widths, with a file it refuses unsent.
      for (const locale of ["en", "de"] as const) {
        for (const theme of ["light", "dark"] as const) {
          for (const width of [1280, 390] as const) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            await view(page, name, locale, theme);
            await page.locator("[data-knowledge-add]").click();
            await expect(upload).toContainText(WORDS[locale].title);
            await upload.locator("input[data-file-picker]").setInputFiles({
              name: "tabelle.csv",
              mimeType: "text/csv",
              buffer: Buffer.from("a,b")
            });
            const refused = upload.locator('[data-knowledge-upload-file="tabelle.csv"]');
            await expect(refused).toHaveAttribute("data-knowledge-upload-state", "failed");
            await expect(refused).toContainText(WORDS[locale].refused);
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth
            );
            expect(overflow).toBeLessThanOrEqual(0);
            await picture(page, `${locale}-${theme}-${width}`);
            await page.locator("[data-knowledge-add-close]").click();
          }
        }
      }
      // On a short phone the dialog's body scrolls, where it must, between its head and footer: its end
      // and its start are reachable, the footer stays in view, and Choose files opens the
      // system's file dialog.
      await page.setViewportSize({ width: 390, height: 640 });
      await view(page, name, "en", "light");
      await page.locator("[data-knowledge-add]").click();
      const dialog = page.locator("[data-knowledge-add-dialog]");
      const body = dialog.locator("xpath=..");
      const choose = page.locator("[data-knowledge-upload-choose]");
      const footer = [
        page.locator("[data-knowledge-add-close]"),
        page.locator("[data-knowledge-add-submit]")
      ];
      await expect(choose).toBeInViewport();
      await body.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
      await expect(dialog.locator("[data-knowledge-chosen]")).toBeInViewport();
      for (const button of footer) await expect(button).toBeInViewport();
      await body.evaluate((element) => element.scrollTo({ top: 0 }));
      await expect(choose).toBeInViewport();
      for (const button of footer) await expect(button).toBeInViewport();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const chooser = page.waitForEvent("filechooser");
      await choose.click();
      expect((await chooser).isMultiple()).toBe(true);
      await page.locator("[data-knowledge-add-close]").click();

      // Nothing refused was sent: the Knowledge Base still has the three documents.
      await expect(documents.locator("[data-knowledge-document]")).toHaveCount(FILES.length);
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
