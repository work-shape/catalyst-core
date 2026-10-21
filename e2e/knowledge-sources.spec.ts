import { randomUUID } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { startKnowledgeApi, type KnowledgeApi } from "./knowledge-api";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, takeTurn, test } from "./test";

// A synced source on the page of a Knowledge Base of documents (SRC-2): the admin adds the
// suite's folder source with folder 100, saves and publishes; the publish question names the
// folders and the shared account. The initial import makes the handbook of folder 100
// searchable, and nothing of folder 200 (the boundary). A person who may publish the Knowledge
// Base but holds no `connection.use` on the Connection is refused when a source is added (the
// Connection's rights), and a reader sees the state without a button. In English and German,
// at 1280 and 390.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** The API with `knowledge` on listens beside the suite's own, on a port no other spec takes. */
const PORT_OFFSET = 19;

type Locale = "en" | "de";

const WORDS: Record<
  Locale,
  { sources: string; current: string; searchable: string; syncNow: string }
> = {
  en: {
    sources: "Synced sources",
    current: "Up to date",
    searchable: "1 searchable",
    syncNow: "Sync now"
  },
  de: {
    sources: "Synchronisierte Quellen",
    current: "Aktuell",
    searchable: "1 durchsuchbar",
    syncNow: "Jetzt synchronisieren"
  }
};

async function signIn(page: Page, api: string, user: { email: string; password: string }) {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** A field of an answer of the instance, read without trusting its shape. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function text(value: unknown, key: string): string {
  const found = field(value, key);
  if (typeof found !== "string") throw new Error(`The answer has no text at ${key}`);
  return found;
}

async function view(page: Page, name: string, locale: Locale, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(`/build/knowledge-bases/${name}`);
  await page.evaluate((chosen) => {
    window.localStorage.setItem("vivd-catalyst:locale", chosen);
    window.localStorage.setItem("vivd-catalyst:theme", "light");
  }, locale);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Handbuch Quellen", level: 1 })).toBeVisible();
}

async function picture(page: Page, label: string) {
  const path = test.info().outputPath(`knowledge-sources-${label}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await test.info().attach(`knowledge-sources-${label}`, { path, contentType: "image/png" });
}

/** No page wider than the window. */
async function fits(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The interface of `page` talks to the API with the module on. */
async function toKnowledgeApi(page: Page, api: KnowledgeApi) {
  await page.route(`${apiBaseUrl}/**`, (route) =>
    route.continue({ url: route.request().url().replace(apiBaseUrl, api.url) })
  );
}

/** The passages a search of the published Knowledge Base finds for `query`. */
async function searched(page: Page, api: KnowledgeApi, name: string, query: string) {
  const response = await requestWithOrigin(
    page,
    "post",
    `${api.url}/api/v1/knowledge-bases/${name}/search`,
    { data: { query } }
  );
  expect(response.ok(), await response.text()).toBe(true);
  return JSON.stringify(field(await response.json(), "passages") ?? []);
}

/** A person of the instance of this spec alone, signed in on a page of their own. */
async function person(
  browser: Browser,
  admin: Page,
  api: KnowledgeApi,
  label: string
): Promise<{ id: string; page: Page; close(): Promise<void> }> {
  const stamp = randomUUID().slice(0, 8);
  const user = {
    email: `e2e-sources-${label}-${stamp}@example.test`,
    password: `e2e-sources-${label}-${stamp}-password`
  };
  const created = await requestWithOrigin(admin, "post", `${api.url}/api/v1/instance/users`, {
    data: {
      displayLabel: `E2E Zz Sources ${label} ${stamp}`,
      email: user.email,
      roles: ["user"],
      passwordSignIn: { password: user.password }
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, apiBaseUrl, user);
  await signIn(page, api.url, user);
  await toKnowledgeApi(page, api);
  return { id: text(await created.json(), "id"), page, close: () => context.close() };
}

test.describe("a synced source on a Knowledge Base's page", () => {
  test.describe.configure({ mode: "serial" });
  let api: KnowledgeApi | undefined;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    // An API that starts makes the release Connections of the shared database equal to its
    // config. It starts when no test holds a Connection it planted there.
    const started = await takeTurn("release-connections", testInfo.project.use.baseURL);
    try {
      api = await startKnowledgeApi(PORT_OFFSET, "e2e-app-knowledge-sources.yaml");
    } finally {
      await started();
    }
  });

  test.afterAll(async () => {
    await api?.stop();
  });

  test("syncs only its folder, asks before it publishes, and holds the Connection's rights", async ({
    page,
    browser,
    accessState: _accessState,
    releaseConnections: _releaseConnections
  }) => {
    test.setTimeout(360_000);
    const knowledge = api;
    if (!knowledge) throw new Error("The API with knowledge on did not start");
    const stamp = randomUUID().slice(0, 8);
    const connection = `e2e-src-folders-${stamp}`;
    const name = `e2e-src-${stamp}`;
    const connectionUrl = `${knowledge.url}/api/v1/assets/connection/${connection}`;
    const assetUrl = `${knowledge.url}/api/v1/assets/knowledge_base/${name}`;
    const people: { close(): Promise<void> }[] = [];
    await signIn(page, apiBaseUrl, superadmin);
    await signIn(page, knowledge.url, superadmin);

    // The suite's folder source, connected as its dialog connects it.
    const put = await requestWithOrigin(page, "put", connectionUrl, {
      data: {
        expectedRevision: null,
        config: {
          name: connection,
          displayName: "Testordner Handbuch",
          connectorType: "test_folders",
          authScheme: "client_credentials",
          settings: { accountId: "konto-1", region: "eu" },
          operations: [],
          enabled: true
        }
      }
    });
    expect(put.ok(), await put.text()).toBe(true);
    const secret = await requestWithOrigin(
      page,
      "put",
      `${knowledge.url}/api/v1/connections/${connection}/secret`,
      { data: { value: "e2e-folder-secret", expectedVersion: null } }
    );
    expect(secret.ok(), await secret.text()).toBe(true);

    const created = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        config: {
          name,
          title: "Handbuch Quellen",
          description: "Das Handbuch aus dem geteilten Ordner.",
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
              await page.request.get(`${knowledge.url}/api/v1/knowledge-bases/${name}/documents`)
            ).status(),
          { timeout: 90_000 }
        )
        .toBe(200);
      await toKnowledgeApi(page, knowledge);

      // The admin adds the source with folder 100, saves the draft and publishes it.
      await view(page, name, "en", 1280);
      const section = page.locator("[data-knowledge-sources]");
      await expect(section).toContainText("No source yet.");
      await section.locator("[data-knowledge-source-add]").click();
      await page.getByRole("option", { name: /Testordner Handbuch/u }).click();
      const source = section.locator(`[data-knowledge-source="${connection}"]`);
      await expect(source).toContainText(connection);
      await source.locator('[data-knowledge-source-field="folders"]').fill("100");
      await expect(source).toContainText("It syncs once it is published.");
      await picture(page, "draft-en-1280");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.locator("[data-build-draft-state]")).toBeVisible();
      await page.locator("[data-build-publish]").click();
      const dialog = page.getByRole("dialog");
      const question = dialog.locator('[data-build-publish-question="ready"]');
      await expect(question).toContainText(
        "with access to “Handbuch Quellen” can find everything in folder 100, read with the shared account"
      );
      await expect(question).toContainText("Their own rights at the source do not apply.");
      await picture(page, "publish-question-en-1280");
      await dialog.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(dialog).toHaveCount(0);

      // The initial import reads folder 100 alone: its handbook is searchable, folder 200's
      // file is not, though the account could read it.
      const status = source.locator("[data-knowledge-source-status]");
      await expect(status).toHaveAttribute("data-knowledge-source-status", "current", {
        timeout: 150_000
      });
      await expect(status).toContainText(WORDS.en.searchable, { timeout: 120_000 });
      expect(await searched(page, knowledge, name, "handbook")).toContain("handbook.txt");
      expect(await searched(page, knowledge, name, "Outside")).not.toContain("other.txt");
      await expect(status.locator("[data-knowledge-source-sync]")).toBeVisible();
      await picture(page, "current-en-1280");

      for (const locale of ["en", "de"] as const) {
        for (const width of [1280, 390]) {
          await view(page, name, locale, width);
          const shown = page.locator(`[data-knowledge-source="${connection}"]`);
          await expect(page.locator("[data-knowledge-sources]")).toBeVisible();
          await expect(shown).toContainText(WORDS[locale].current);
          await expect(shown).toContainText(WORDS[locale].searchable);
          await expect(shown).toContainText(WORDS[locale].syncNow);
          await shown.scrollIntoViewIfNeeded();
          await fits(page);
          await picture(page, `${locale}-${width}`);
        }
      }

      // Who may change and publish the Knowledge Base, without `connection.use` on the
      // Connection, is refused when a source through it is added, and nothing is published.
      const assetId = text(await (await page.request.get(assetUrl)).json(), "id");
      const grant = async (holderId: string, action: string) => {
        const granted = await requestWithOrigin(
          page,
          "post",
          `${knowledge.url}/api/v1/instance/access/grants`,
          {
            data: {
              holderKind: "user",
              holderId,
              action,
              effect: "allow",
              scopeKind: "asset",
              scopeId: assetId
            }
          }
        );
        expect(granted.ok(), await granted.text()).toBe(true);
      };
      const publisher = await person(browser, page, knowledge, "publisher");
      people.push(publisher);
      for (const action of [
        "knowledge_base.read",
        "knowledge_base.write",
        "knowledge_base.publish"
      ]) {
        await grant(publisher.id, action);
      }
      const current = await page.request.get(assetUrl);
      const config = field(await current.json(), "config");
      const sources = field(config, "sources");
      expect(Array.isArray(sources)).toBe(true);
      const widened = await requestWithOrigin(page, "put", assetUrl, {
        data: {
          expectedRevision: await assetRevision(page, assetUrl),
          config: {
            ...(config as Record<string, unknown>),
            sources: [
              ...(sources as unknown[]),
              { id: "other-folder", connection, folders: ["200"] }
            ]
          }
        }
      });
      expect(widened.ok(), await widened.text()).toBe(true);
      const publishedBefore = field(
        await (await page.request.get(assetUrl)).json(),
        "publishedRevision"
      );
      await view(publisher.page, name, "de", 1280);
      await publisher.page.locator("[data-build-publish]").click();
      const asked = publisher.page.getByRole("dialog");
      await expect(asked.locator('[data-build-publish-question="ready"]')).toContainText(
        "im Ordner 200, gelesen mit dem gemeinsamen Konto"
      );
      await asked.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
      await expect(asked).toHaveCount(0);
      const refused = publisher.page.locator("[data-build-failure]");
      // Refused for the Connection's right, not for anything else about the draft.
      await expect(refused).toContainText("connection.use");
      await expect(publisher.page.locator("[data-build-draft-state]")).toBeVisible();
      await picture(publisher.page, "publish-refused-de-1280");
      expect(field(await (await page.request.get(assetUrl)).json(), "publishedRevision")).toBe(
        publishedBefore
      );
      expect(await searched(page, knowledge, name, "Outside")).not.toContain("other.txt");

      // A reader sees the state of the source and no button.
      const reader = await person(browser, page, knowledge, "reader");
      people.push(reader);
      await grant(reader.id, "knowledge_base.read");
      for (const width of [1280, 390]) {
        await view(reader.page, name, "de", width);
        const shown = reader.page.locator(`[data-knowledge-source="${connection}"]`);
        await expect(shown).toContainText(WORDS.de.current);
        await expect(reader.page.locator("[data-knowledge-source-sync]")).toHaveCount(0);
        await expect(reader.page.locator("[data-knowledge-source-add]")).toHaveCount(0);
        await expect(reader.page.locator("[data-knowledge-source-remove]")).toHaveCount(0);
        await expect(reader.page.locator("[data-build-publish]")).toHaveCount(0);
        await fits(reader.page);
        await picture(reader.page, `reader-de-${width}`);
      }
    } finally {
      for (const opened of people) await opened.close();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      if ((await page.request.get(assetUrl)).ok()) {
        await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
          data: { expectedRevision: await assetRevision(page, assetUrl) }
        });
      }
      if ((await page.request.get(connectionUrl)).ok()) {
        await requestWithOrigin(page, "post", `${connectionUrl}/delete`, {
          data: { expectedRevision: await assetRevision(page, connectionUrl) }
        });
      }
    }
  });
});
