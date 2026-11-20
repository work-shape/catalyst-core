import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { chooseAddDocuments, openKnowledgeSettings } from "./knowledge-page";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, takeTurn, test } from "./test";

// Pictures of the page of a published Knowledge Base of documents, for a person to look at: its
// lead line, the line that counts its documents, the list and the folded Settings, in German,
// light and dark, at 1280. Then the same page as one whose documents come from a synced folder:
// its head with the main action, the source's card folded and with Adjust open. Last, the page
// of one that answers from the tables of a Data Store, and the folder chooser of a synced source
// with a folder left out. It runs only with KB_PAGE_SHOTS=1 and writes to test-results/kb-page.
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

/** The list of documents as far as the pictures change it; the rest passes through. */
const listSchema = z.looseObject({
  documents: z.array(z.looseObject({ fileName: z.string() }))
});

/** The state of a Knowledge Base of tables as far as the pictures change it. */
const stateSchema = z.looseObject({
  tables: z.array(z.looseObject({ name: z.string(), readable: z.boolean() }))
});

const SHOTS = resolve("test-results/kb-page");
const TITLE = "Teamhandbuch";
const TABLES_TITLE = "Projektübersicht";

/** The Data Store the Knowledge Base of tables reads: three tables, two of them described. */
const storeFiles = (store: string) => [
  { path: "store.yaml", text: `id: ${store}\nname: Projektdaten\n` },
  {
    path: "migrations/0001_init.sql",
    text: [
      "create table projekte (",
      "  nummer text primary key,",
      "  name text not null,",
      "  ort text not null,",
      "  fertigstellung date",
      ");",
      "create table einheiten (",
      "  nummer text primary key,",
      "  projekt text not null references projekte (nummer),",
      "  flaeche numeric not null,",
      "  stand text not null",
      ");",
      "create table einheiten_auswertung (",
      "  projekt text primary key references projekte (nummer),",
      "  einheiten bigint not null,",
      "  frei bigint not null",
      ");",
      ""
    ].join("\n")
  }
];

/** The synced folder the second set of pictures shows: a source, its Connection and its folder. */
const SYNCED = {
  source: "haus-a",
  connection: "projektablage",
  connectionTitle: "Projektablage",
  folderId: "100",
  folderPath: "Projekte / Haus A"
} as const;

/** The folders the chooser's pictures walk, by the id of the folder asked for; `""` is the top. */
const PICKER_FOLDERS: Record<string, unknown> = {
  "": {
    folder: { id: "0", name: "Alle Dateien", path: "/" },
    folders: [
      { id: "10", name: "Projekte" },
      { id: "20", name: "Verträge" },
      { id: "30", name: "Vorlagen" }
    ]
  },
  "10": {
    folder: { id: "10", name: "Projekte", path: "/Projekte" },
    folders: [
      { id: "11", name: "Archiv" },
      { id: "12", name: "Haus A" },
      { id: "13", name: "Haus B" },
      { id: "14", name: "Haus C" }
    ]
  }
};

/** An asset and a list of assets as far as the pictures change them. */
const assetSchema = z.looseObject({ config: z.looseObject({}) });
const assetListSchema = z.looseObject({ items: z.array(z.looseObject({})) });

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
async function picture(
  page: Page,
  label: string,
  content = "[data-knowledge-documents]"
): Promise<void> {
  const extra = await page.locator(content).evaluate((element) => {
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

/**
 * Makes the page of `name` one whose documents come from a synced folder. Only what the instance
 * answers is changed: the definition names a source, a Connection that lets a person choose
 * folders is listed, and the source is up to date.
 */
async function asSynced(
  page: Page,
  name: string,
  documents: number,
  folders: readonly string[] = [SYNCED.folderId]
): Promise<void> {
  await page.route(`${apiBaseUrl}/api/v1/assets/knowledge_base/${name}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch({
      url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl)
    });
    const body = assetSchema.parse(await response.json());
    await route.fulfill({
      response,
      json: {
        ...body,
        config: {
          ...body.config,
          sources: [
            {
              id: SYNCED.source,
              connection: SYNCED.connection,
              folders
            }
          ]
        }
      }
    });
  });
  const connectionList = (url: URL) =>
    url.origin === new URL(apiBaseUrl).origin && url.pathname === "/api/v1/assets/connection";
  await page.route(connectionList, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl)
    });
    const body = assetListSchema.parse(await response.json());
    // Once, with the instance's own: the list is asked per owner.
    const listed = url.searchParams.has("workspaceId")
      ? []
      : [
          {
            id: `connection:${SYNCED.connection}`,
            kind: "connection",
            name: SYNCED.connection,
            title: SYNCED.connectionTitle,
            scope: { kind: "instance" },
            revision: 1,
            publishedRevision: 1,
            attributes: {
              connectorType: "test_folders",
              documentSource: true,
              browsesFolders: true,
              enabled: true
            },
            updatedAt: "2026-11-18T09:00:00.000Z"
          }
        ];
    await route.fulfill({ response, json: { ...body, items: [...listed, ...body.items] } });
  });
  await page.route(`${apiBaseUrl}/api/v1/knowledge-bases/${name}/sources`, (route) =>
    route.fulfill({
      json: {
        sources: [
          {
            id: SYNCED.source,
            connection: SYNCED.connection,
            kind: "connector",
            items: {
              discovered: 0,
              fetched: 0,
              indexed: documents,
              failed: 0,
              withdrawn: 0
            },
            failures: [],
            last: {
              syncRunId: "sync-1",
              source: SYNCED.source,
              mode: "changes",
              state: "done",
              counts: {
                discovered: documents,
                added: 0,
                changed: 0,
                moved: 0,
                withdrawn: 0,
                failed: 0,
                skipped: 0
              },
              bytesFetched: 0,
              startedAt: "2026-11-18T09:14:00.000Z",
              endedAt: "2026-11-18T09:15:00.000Z"
            },
            schedule: {
              changes: 15,
              full: "0 2 * * *",
              defaultChanges: 15,
              defaultFull: "0 2 * * *",
              minChanges: 5
            },
            lastChangeAt: "2026-11-18T09:15:00.000Z"
          }
        ]
      }
    })
  );
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

      // Two of the documents are shown as a synced source would list them: one name in two
      // folders, each with its original. Only the answered list is changed, not the store.
      const twins: Record<string, string> = {
        "urlaub.txt": "/Projekte/Haus A",
        "homeoffice.txt": "/Projekte/Haus B"
      };
      await page.route(`${apiBaseUrl}/api/v1/knowledge-bases/${name}/documents*`, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch({
          url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl)
        });
        const body = listSchema.parse(await response.json());
        const documents = body.documents.map((entry) => {
          const folder = twins[entry.fileName];
          return folder === undefined
            ? entry
            : {
                ...entry,
                title: "Grundriss.txt",
                folder,
                originLink: `https://files.example.test${encodeURI(folder)}/Grundriss.txt`
              };
        });
        await route.fulfill({ response, json: { ...body, documents } });
      });

      for (const theme of ["light", "dark"] as const) {
        await view(page, name, theme);
        await picture(page, `de-${theme}`);
      }
      await view(page, name, "light");
      await openKnowledgeSettings(page);
      await picture(page, "de-light-settings");

      // The same page as one whose documents all come from a synced folder. Only what the
      // instance answers is changed: the definition names a source, a Connection that lets a
      // person choose folders is listed, the source is up to date, and each document is its.
      await asSynced(page, name, FILES.length);
      await page.route(
        `${apiBaseUrl}/api/v1/connections/${SYNCED.connection}/source-folders*`,
        (route) =>
          route.fulfill({
            json: {
              folder: { id: SYNCED.folderId, name: "Haus A", path: SYNCED.folderPath },
              folders: []
            }
          })
      );
      await page.route(`${apiBaseUrl}/api/v1/knowledge-bases/${name}/documents*`, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch({
          url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl)
        });
        const body = listSchema.parse(await response.json());
        const documents = body.documents.map((entry) => ({
          ...entry,
          sourceId: SYNCED.source,
          folder: "/Projekte/Haus A",
          originLink: `https://files.example.test/Projekte/Haus%20A/${entry.fileName}`
        }));
        await route.fulfill({ response, json: { ...body, documents } });
      });

      for (const theme of ["light", "dark"] as const) {
        await view(page, name, theme);
        const card = page.locator(`[data-knowledge-source="${SYNCED.source}"]`);
        await expect(card).toContainText(SYNCED.folderPath);
        await picture(page, `synced-de-${theme}`);
        if (theme === "light") {
          // The head of the page with its main action, and the card as it stands folded.
          await page.screenshot({
            path: resolve(SHOTS, "kb-page-synced-de-light-head.png"),
            clip: { x: 0, y: 0, width: 1280, height: 420 },
            animations: "disabled"
          });
          await card.screenshot({
            path: resolve(SHOTS, "kb-page-synced-de-light-card-folded.png"),
            animations: "disabled"
          });
          // What the head's menu offers beside the main action.
          await page.getByRole("button", { name: "Weitere Aktionen" }).first().click();
          await expect(page.getByRole("menu")).toBeVisible();
          await page.screenshot({
            path: resolve(SHOTS, "kb-page-synced-de-light-head-menu.png"),
            clip: { x: 0, y: 0, width: 1280, height: 420 },
            animations: "disabled"
          });
          await page.keyboard.press("Escape");
          await expect(page.getByRole("menu")).toHaveCount(0);
        }
        await card.locator("[data-knowledge-source-adjust]").click();
        await expect(card.locator("[data-knowledge-source-status]")).toBeVisible();
        await picture(page, `synced-de-${theme}-adjust`);
        await card.screenshot({
          path: resolve(SHOTS, `kb-page-synced-de-${theme}-card-adjust.png`),
          animations: "disabled"
        });
        // Where the time is one button, what it opens.
        const when = card.locator("[data-knowledge-source-sync-when]");
        if (theme === "light" && (await when.count()) > 0) {
          await when.click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await picture(page, "synced-de-light-adjust-time");
          await page.keyboard.press("Escape");
        }
      }
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      if ((await page.request.get(assetUrl)).ok()) {
        await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
          data: { expectedRevision: await assetRevision(page, assetUrl) }
        });
      }
    }
  });

  // The folder chooser of a synced source: a folder chosen with everything below it, one folder
  // below it left out, and what the chooser and the source's card then say, light and dark.
  test("de: the folder chooser with a folder left out below a chosen one", async ({ page }) => {
    test.setTimeout(240000);
    const name = `e2e-screens-folders-${randomUUID().slice(0, 8)}`;
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
          description: "Die Unterlagen aller Projekte, wie sie im Ordner Projekte liegen.",
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
      await expect
        .poll(
          async () =>
            (
              await page.request.get(`${knowledgeApiUrl}/api/v1/knowledge-bases/${name}/documents`)
            ).status(),
          { timeout: 90000 }
        )
        .toBe(200);
      await page.route(`${apiBaseUrl}/**`, (route) =>
        route.continue({ url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl) })
      );
      await asSynced(page, name, 0, ["10"]);
      await page.route(
        `${apiBaseUrl}/api/v1/connections/${SYNCED.connection}/source-folders*`,
        (route) => {
          const parent = new URL(route.request().url()).searchParams.get("parent") ?? "";
          const folder = PICKER_FOLDERS[parent];
          return folder === undefined
            ? route.fulfill({ status: 404, json: {} })
            : route.fulfill({ json: folder });
        }
      );

      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`/build/knowledge-bases/${name}`);
        await page.evaluate((chosen) => {
          window.localStorage.setItem("vivd-catalyst:locale", "de");
          window.localStorage.setItem("vivd-catalyst:theme", chosen);
        }, theme);
        await page.reload();
        await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
        const card = page.locator(`[data-knowledge-source="${SYNCED.source}"]`);
        await expect(card).toContainText("/Projekte");
        await card.locator("[data-knowledge-source-adjust]").click();
        await card.locator("[data-knowledge-source-pick]").click();
        const chooser = page.getByRole("dialog");
        const row = (id: string) => chooser.locator(`[data-knowledge-folder="${id}"]`);
        const summary = chooser.locator("[data-knowledge-folders-summary]");

        // The chosen folder is read whole: its box is ticked, and so is each folder below it.
        await expect(row("10")).toHaveAttribute("data-knowledge-folder-state", "all");
        await expect(row("20")).toHaveAttribute("data-knowledge-folder-state", "none");
        await expect(summary).toHaveText("Projekte und alles darunter");
        await row("10").locator("[data-knowledge-folder-open]").click();
        await expect(row("11")).toHaveAttribute("data-knowledge-folder-state", "all");

        // One folder below it is left out. The folder above then reads as chosen in part.
        await row("11").getByRole("checkbox").click();
        await expect(row("11")).toHaveAttribute("data-knowledge-folder-state", "none");
        await expect(row("11")).toContainText("ausgelassen");
        await expect(chooser.locator("[data-knowledge-folder-here]")).toHaveAttribute(
          "aria-checked",
          "mixed"
        );
        await expect(summary).toHaveText("Projekte und alles darunter, ohne Archiv");
        await expect(chooser.locator("[data-knowledge-folders-count]")).toHaveText(
          "1 Ordner · 1 ausgelassen"
        );
        await chooser.screenshot({
          path: resolve(SHOTS, `kb-folder-picker-de-${theme}-left-out.png`),
          animations: "disabled"
        });
        await chooser.getByRole("button", { name: SYNCED.connectionTitle }).click();
        await expect(row("10")).toHaveAttribute("data-knowledge-folder-state", "some");
        await expect(row("10").getByRole("checkbox")).toHaveAttribute("aria-checked", "mixed");
        await expect(row("10")).toContainText("ohne Archiv");
        await chooser.screenshot({
          path: resolve(SHOTS, `kb-folder-picker-de-${theme}-partly.png`),
          animations: "disabled"
        });

        // The source keeps the folder as its boundary and leaves the one out by a pattern.
        await chooser.locator("[data-knowledge-folders-apply]").click();
        await expect(chooser).toHaveCount(0);
        await expect(card).toContainText("/Projekte, ohne Archiv");
        await expect(
          card.locator('[data-knowledge-source-excluded-folder="Archiv"]')
        ).toBeVisible();
        await page.setViewportSize({ width: 1280, height: 1600 });
        await card.screenshot({
          path: resolve(SHOTS, `kb-folder-picker-de-${theme}-card.png`),
          animations: "disabled"
        });
        await card.locator("[data-knowledge-source-advanced] button").first().click();
        await expect(card.locator('[data-knowledge-source-field="folders"]')).toHaveValue("10");
        await expect(card.locator('[data-knowledge-source-field="exclude"]')).toHaveValue(
          "Archiv/**"
        );
      }
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      if ((await page.request.get(assetUrl)).ok()) {
        await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
          data: { expectedRevision: await assetRevision(page, assetUrl) }
        });
      }
    }
  });

  // The page of a published Knowledge Base that answers from the tables of a Data Store: its
  // lead line, its tables, the test and the folded Settings, then with everything unfolded.
  test("de: a Knowledge Base of tables, light and dark, and with Settings unfolded", async ({
    page
  }) => {
    test.setTimeout(240000);
    const tag = randomUUID().slice(0, 8);
    const name = `e2e-screens-tables-${tag}`;
    const store = `e2e-screens-store-${tag}`;
    const assetUrl = `${knowledgeApiUrl}/api/v1/assets/knowledge_base/${name}`;
    const storeUrl = `${knowledgeApiUrl}/api/v1/assets/data_store/${store}`;
    await mkdir(SHOTS, { recursive: true });
    await signIn(page, apiBaseUrl);
    await signIn(page, knowledgeApiUrl);
    try {
      const stored = await requestWithOrigin(page, "put", storeUrl, {
        data: { expectedRevision: null, files: storeFiles(store) }
      });
      expect(stored.ok(), await stored.text()).toBe(true);
      const storePublished = await requestWithOrigin(page, "post", `${storeUrl}/publish`, {
        data: { revision: 1 }
      });
      expect(storePublished.ok(), await storePublished.text()).toBe(true);
      await expect
        .poll(
          async () =>
            (
              await page.request.get(`${knowledgeApiUrl}/api/v1/data-stores/${store}/describe`)
            ).status(),
          { timeout: 60000 }
        )
        .toBe(200);
      const created = await requestWithOrigin(page, "put", assetUrl, {
        data: {
          expectedRevision: null,
          config: {
            name,
            title: TABLES_TITLE,
            description: "Alle Bauprojekte mit ihren Einheiten und wie viele davon noch frei sind.",
            methods: ["structured"],
            backend: { dataStore: store },
            tables: [
              {
                name: "projekte",
                description:
                  "Eine Zeile je Bauprojekt mit Nummer, Name, Ort und dem geplanten Tag der Fertigstellung."
              },
              {
                name: "einheiten_auswertung",
                description:
                  "Eine Zeile je Projekt: wie viele Einheiten es hat und wie viele davon noch frei sind."
              }
            ]
          }
        }
      });
      expect(created.ok(), await created.text()).toBe(true);
      const published = await requestWithOrigin(page, "post", `${assetUrl}/publish`, {
        data: { revision: 1 }
      });
      expect(published.ok(), await published.text()).toBe(true);
      // The interface talks to the API with the module on.
      await page.route(`${apiBaseUrl}/**`, (route) =>
        route.continue({ url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl) })
      );
      const tables = "[data-knowledge-tables]";
      const viewTables = async (theme: "light" | "dark") => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`/build/knowledge-bases/${name}`);
        await page.evaluate((chosen) => {
          window.localStorage.setItem("vivd-catalyst:locale", "de");
          window.localStorage.setItem("vivd-catalyst:theme", chosen);
        }, theme);
        await page.reload();
        await expect(page.getByRole("heading", { name: TABLES_TITLE, level: 1 })).toBeVisible();
        await expect(page.locator("[data-knowledge-table]")).toHaveCount(3);
        await expect(page.locator("[data-knowledge-state]")).toHaveCount(1);
      };
      for (const theme of ["light", "dark"] as const) {
        await viewTables(theme);
        await picture(page, `tables-de-${theme}`, tables);
      }
      await viewTables("light");
      await openKnowledgeSettings(page);
      // What only whoever runs it reads is folded once more.
      const advanced = page.locator("[data-knowledge-advanced-trigger]");
      if ((await advanced.count()) > 0) {
        await advanced.click();
        await expect(advanced).toHaveAttribute("aria-expanded", "true");
      }
      await picture(page, "tables-de-light-settings", tables);

      // The same page after a check that could not read one table: what needs a person stands
      // at the top. Only the answered state is changed.
      await page.route(`${apiBaseUrl}/api/v1/knowledge-bases/${name}`, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch({
          url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl)
        });
        const body = stateSchema.parse(await response.json());
        await route.fulfill({
          response,
          json: {
            ...body,
            status: "needs_attention",
            tables: body.tables.map((table) =>
              table.name === "projekte" ? table : { ...table, readable: false }
            )
          }
        });
      });
      await viewTables("light");
      await expect(page.locator("[data-knowledge-attention]")).toBeVisible();
      await picture(page, "tables-de-light-attention", tables);
      await page.locator("[data-knowledge-attention] button").click();
      await expect(page.locator("[data-knowledge-table-state]").first()).toBeVisible();
      await picture(page, "tables-de-light-attention-status", tables);
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      for (const url of [assetUrl, storeUrl]) {
        if ((await page.request.get(url)).ok()) {
          await requestWithOrigin(page, "post", `${url}/delete`, {
            data: { expectedRevision: await assetRevision(page, url) }
          });
        }
      }
    }
  });
});
