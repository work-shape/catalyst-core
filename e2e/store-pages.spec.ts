import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, takeTurn, test } from "./test";
import { apiOrigin } from "./view-fixtures";

// STORE-PAGES. The page of a published Data Store whose draft adds a migration lists that
// migration with its SQL and publishes it after a question; the store's state follows the
// publish without a reload. "Edit with the agent" opens the dock beside the page with a
// conversation about the store, and Delete in the head's menu asks with the store's name and
// leaves for the list. The page of a Knowledge Base names the agents that search it and those
// given knowledge_base.use, and opens its own conversation with the agent; its row on the list
// says how many documents it holds, when the last was ingested and the ingestion's state.
// Pictures in English and German, light and dark, at 390 wide, and a scroll in a window 640
// high, go to the test's output folder.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const configPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** The API with `knowledge` on listens beside the suite's own, on a port no other spec takes. */
const knowledgeApiPort = Number(new URL(apiOrigin).port) + 17;
const knowledgeApiUrl = `http://${host}:${knowledgeApiPort}`;

const WIDE = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const SHORT_PHONE = { width: 390, height: 640 };
const EDIT = "Edit with the agent";

type Locale = "en" | "de";
type Theme = "light" | "dark";
const LOCALES = ["en", "de"] as const;
const THEMES = ["light", "dark"] as const;

const WORDS: Record<
  Locale,
  {
    publish: string;
    delete: string;
    more: string;
    kbAgents: string;
    kbAccess: string;
    kbList: string;
    kbSearch: string;
    documents: string;
    lastIngested: string;
    ingesting: string;
  }
> = {
  en: {
    publish: "Publish",
    delete: "Delete",
    more: "More actions",
    kbAgents: "Used by agents",
    kbAccess: "Additional use rights",
    kbList: "Knowledge bases",
    kbSearch: "Search knowledge bases",
    documents: "12 documents",
    lastIngested: "Last ingested",
    ingesting: "Ingesting"
  },
  de: {
    publish: "Veröffentlichen",
    delete: "Löschen",
    more: "Weitere Aktionen",
    kbAgents: "Verwendet von Agenten",
    kbAccess: "Zusätzliche Nutzungsrechte",
    kbList: "Wissensbasen",
    kbSearch: "Wissensbasen durchsuchen",
    documents: "12 Dokumente",
    lastIngested: "Zuletzt eingelesen",
    ingesting: "Wird eingelesen"
  }
};

const revisionSchema = z.object({ revision: z.number() });
const idSchema = z.object({ id: z.string() });

const FIRST = "create table leads (id bigint primary key, name text not null);";
const LATER = "alter table leads add column note text;";

async function signIn(page: Page, api: string): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/**
 * Opens `path` in `locale` and `theme`, both chosen before the reload that reads them, and
 * waits for the heading. The page's theme and a label of the locale are asserted, so a picture
 * never shows another language or theme than its name says.
 */
async function view(page: Page, path: string, heading: string, locale: Locale, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(path);
  await page.evaluate(
    (chosen) => {
      window.localStorage.setItem("vivd-catalyst:locale", chosen.locale);
      window.localStorage.setItem("vivd-catalyst:theme", chosen.theme);
    },
    { locale, theme }
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-vivd-theme", theme);
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
}

async function picture(page: Page, label: string) {
  const path = test.info().outputPath(`store-pages-${label}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await test.info().attach(`store-pages-${label}`, { path, contentType: "image/png" });
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The detail head stays pinned at intermediate scroll positions and at the end. */
async function pinnedHead(page: Page, title: string) {
  const heading = page.getByRole("heading", { name: title, level: 1 });
  const setScroll = (fraction: number) =>
    heading.evaluate((element, at) => {
      let scroll = element.parentElement;
      while (
        scroll &&
        !(
          scroll.scrollHeight > scroll.clientHeight &&
          /auto|scroll/u.test(getComputedStyle(scroll).overflowY)
        )
      )
        scroll = scroll.parentElement;
      if (!scroll) throw new Error("The detail page has no scroll container");
      scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * at;
    }, fraction);
  await setScroll(0);
  const top = await heading.evaluate((element) => element.getBoundingClientRect().top);
  for (const fraction of [0.25, 0.5, 1]) {
    await setScroll(fraction);
    await expect
      .poll(async () =>
        Math.abs((await heading.evaluate((element) => element.getBoundingClientRect().top)) - top)
      )
      .toBeLessThanOrEqual(1);
    await expect(heading).toBeInViewport();
  }
}

/** The store's files: its definition and the migrations given. */
function storeFiles(name: string, title: string, migrations: readonly string[]) {
  return [
    { path: "store.yaml", text: `id: ${name}\nname: ${title}\n` },
    ...migrations.map((sql, index) => ({
      path: `migrations/000${index + 1}_${index === 0 ? "init" : "add_note"}.sql`,
      text: sql
    }))
  ];
}

test("a Data Store's later draft is published, edited with the agent and deleted from its page", async ({
  page,
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(240_000);
  await signIn(page, apiOrigin);
  const personal = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces/personal`);
  expect(personal.ok()).toBe(true);
  idSchema.parse(await personal.json());

  const name = `store-pages-${randomUUID().slice(0, 8)}`;
  const title = "Store page leads";
  const path = `/build/data-stores/${name}`;
  const address = `${apiOrigin}/api/v1/assets/data_store/${name}`;
  const agentName = `${name}-scout`;
  const agentAddress = `${apiOrigin}/api/v1/assets/agent/${agentName}`;
  const otherName = `${name}-other`;
  const otherAddress = `${apiOrigin}/api/v1/assets/data_store/${otherName}`;
  try {
    // Published at level 1.
    const first = await requestWithOrigin(page, "put", address, {
      data: { expectedRevision: null, files: storeFiles(name, title, [FIRST]) }
    });
    expect(first.ok(), await first.text()).toBe(true);
    const firstRevision = revisionSchema.parse(await first.json()).revision;
    const published = await requestWithOrigin(page, "post", `${address}/publish`, {
      data: { revision: firstRevision }
    });
    expect(published.ok(), await published.text()).toBe(true);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`${apiOrigin}/api/v1/data-stores/${name}`);
          return response.ok() ? response.json() : undefined;
        },
        { timeout: 30_000 }
      )
      .toMatchObject({ status: "ready", level: 1 });
    const agent = await requestWithOrigin(page, "put", agentAddress, {
      data: {
        expectedRevision: null,
        availableIn: "all",
        config: {
          name: agentName,
          displayName: "Lead scout",
          modelProviderId: "local",
          instructions: "Read the lead records.",
          toolNames: [`data_store.${name}.query`]
        }
      }
    });
    expect(agent.ok(), await agent.text()).toBe(true);
    // A new agent is live on create in the current agent lifecycle.
    await expect.poll(async () => (await page.request.get(agentAddress)).ok()).toBe(true);
    const other = await requestWithOrigin(page, "put", otherAddress, {
      data: { expectedRevision: null, files: storeFiles(otherName, "Another store", [FIRST]) }
    });
    expect(other.ok(), await other.text()).toBe(true);
    // A later draft adds migration 2.
    const later = await requestWithOrigin(page, "put", address, {
      data: { expectedRevision: firstRevision, files: storeFiles(name, title, [FIRST, LATER]) }
    });
    expect(later.ok(), await later.text()).toBe(true);

    // The page in both languages and themes at 390: what the publish applies, with its SQL.
    await page.setViewportSize(PHONE);
    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        await view(page, path, title, locale, theme);
        const pending = page.locator("[data-data-store-pending]");
        await expect(pending.locator("[data-data-store-draft-migration]")).toHaveText([
          "0002_add_note.sql"
        ]);
        await expect(pending.locator("[data-data-store-migration-sql]")).toContainText(LATER);
        await expect(pending).not.toContainText(FIRST);
        await expect(
          page.getByRole("button", { name: WORDS[locale].publish, exact: true })
        ).toBeVisible();
        await noSidewaysScroll(page);
        await picture(page, `store-pending-${locale}-${theme}-390`);
        await page.getByRole("button", { name: WORDS[locale].more }).click();
        await expect(page.getByRole("menuitem", { name: WORDS[locale].delete })).toBeVisible();
        await picture(page, `store-menu-${locale}-${theme}-390`);
        await page.keyboard.press("Escape");
        const row = page.locator(`[data-data-store-agent="${agentName}"]`);
        await expect(row).toContainText("Lead scout");
        await expect(row.locator("a")).toHaveAttribute("href", `/build/agents/${agentName}`);
        await row.scrollIntoViewIfNeeded();
        await picture(page, `store-agents-${locale}-${theme}-390`);
      }
    }

    // Another selection and back twice keeps the draft SQL and the state with their own store.
    for (let change = 0; change < 2; change++) {
      await view(page, `/build/data-stores/${otherName}`, "Another store", "en", "light");
      await expect(page.locator("[data-data-store-migration-sql]")).toContainText(FIRST);
      await view(page, path, title, "en", "light");
      await expect(page.locator("[data-data-store-migration-sql]")).toContainText(LATER);
      await expect(page.locator("[data-data-store-migration-sql]")).not.toContainText(FIRST);
    }

    // In a window 640 high the page scrolls: the SQL, the last section and the head are each
    // reachable, and nothing scrolls sideways.
    await page.setViewportSize(SHORT_PHONE);
    await view(page, path, title, "en", "light");
    await pinnedHead(page, title);
    const sql = page.locator("[data-data-store-migration-sql]").first();
    await sql.scrollIntoViewIfNeeded();
    await expect(sql).toBeInViewport();
    await picture(page, "store-scroll-sql-en-light-390x640");
    const last = page.locator("section[id]").last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await picture(page, "store-scroll-end-en-light-390x640");
    await page.getByRole("heading", { name: title, level: 1 }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: WORDS.en.more })).toBeInViewport();
    await noSidewaysScroll(page);

    // Publish asks first; the confirm applies migration 2, and the state follows without a
    // reload.
    await page.setViewportSize(PHONE);
    await view(page, path, title, "en", "light");
    await page.locator("[data-data-store-publish]").click();
    await expect(page.locator("[data-data-store-publish-confirm]")).toContainText(
      "1 new migration"
    );
    await picture(page, "store-publish-question-en-light-390");
    await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.locator("[data-data-store-pending]")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator("#status")).toContainText("0002_add_note", { timeout: 30_000 });

    // "Edit with the agent" opens the dock beside the store's page, about the store. Wide, the
    // action stands in the head.
    await page.setViewportSize(WIDE);
    await view(page, path, title, "en", "light");
    await page.getByRole("button", { name: EDIT, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === path && url.searchParams.has("chat"));
    const dockHead = page.getByTestId("dock-head");
    await expect(dockHead).toHaveAttribute("data-subject-kind", "data_store");
    await expect(dockHead).toContainText(`Working on: ${title}`);
    await expect(page.getByText("Add a table", { exact: true })).toBeVisible();
    await expect(page.getByText("Add a column", { exact: true })).toBeVisible();
    await picture(page, "store-agent-en-light-1280");

    // The list's shared metadata names its App. Only this visual App reference is planted;
    // the real published-reference scan is covered by the API integration test.
    await page.route(
      (url) => url.origin === apiOrigin && url.pathname === "/api/v1/data-stores",
      async (route) => {
        const response = await route.fetch();
        const list = z
          .object({ items: z.array(z.object({ name: z.string() }).passthrough()) })
          .passthrough()
          .parse(await response.json());
        await route.fulfill({
          response,
          json: {
            ...list,
            items: list.items.map((item) =>
              item.name === name
                ? { ...item, apps: [{ name: "lead-board", title: "Lead board" }] }
                : item
            )
          }
        });
      }
    );
    await page.setViewportSize(PHONE);
    for (const locale of LOCALES)
      for (const theme of THEMES) {
        await view(
          page,
          "/build/data-stores",
          locale === "en" ? "Data stores" : "Datenspeicher",
          locale,
          theme
        );
        await page.getByRole("searchbox").fill(name);
        const apps = page.locator(`[data-data-store-row-apps="${name}"]`);
        await expect(apps).toContainText("Lead board");
        await expect(apps).toBeVisible();
        await noSidewaysScroll(page);
        await picture(page, `store-row-${locale}-${theme}-390`);
      }
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // Delete asks with the store's name and leaves for the list of stores.
    await page.setViewportSize(PHONE);
    await view(page, path, title, "en", "light");
    await page.getByRole("button", { name: WORDS.en.more }).click();
    await page.getByRole("menuitem", { name: WORDS.en.delete }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(title);
    await expect(page.locator("[data-data-store-delete-confirm]")).toBeVisible();
    await picture(page, "store-delete-question-en-light-390");
    await dialog.getByRole("button", { name: WORDS.en.delete, exact: true }).click();
    await expect(page.locator("[data-data-store-delete-failed]")).toContainText("still in use");
    await expect(page).toHaveURL((url) => url.pathname === path);
    await picture(page, "store-delete-blocked-en-light-390");
    const removedAgent = await requestWithOrigin(page, "post", `${agentAddress}/delete`, {
      data: { expectedRevision: await assetRevision(page, agentAddress) }
    });
    expect(removedAgent.ok(), await removedAgent.text()).toBe(true);
    await page.getByRole("button", { name: WORDS.en.more }).click();
    await page.getByRole("menuitem", { name: WORDS.en.delete }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: WORDS.en.delete, exact: true })
      .click();
    await expect(page).toHaveURL((url) => url.pathname === "/build/data-stores");
    // The store is retired: its asset is gone, though its rows stay on the server.
    expect((await page.request.get(address)).ok()).toBe(false);
  } finally {
    await page.goto("about:blank");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const url of [agentAddress, otherAddress, address]) {
      const left = await page.request.get(url);
      if (left.ok())
        await requestWithOrigin(page, "post", `${url}/delete`, {
          data: { expectedRevision: revisionSchema.parse(await left.json()).revision }
        });
    }
  }
});

test.describe("the page and the row of a Knowledge Base", () => {
  test.describe.configure({ mode: "serial" });
  const processes: ChildProcess[] = [];

  // The suite's instance runs without the module `knowledge`: a second API runs the same
  // instance with it on, on the same database, as knowledge-upload.spec.ts does.
  test.beforeAll(async ({}, testInfo) => {
    const started = await takeTurn("release-connections", testInfo.project.use.baseURL);
    try {
      await startKnowledge();
    } finally {
      await started();
    }
  });

  async function startKnowledge(): Promise<void> {
    const onConfigPath = resolve(dirname(resolve(configPath)), "e2e-app-store-pages.yaml");
    const config = (await readFile(configPath, "utf8")).replaceAll(apiOrigin, knowledgeApiUrl);
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

  test("names its agents and holders, opens a conversation about it, and lists its documents", async ({
    page,
    instanceAgentsChange: _instanceAgentsChange
  }) => {
    test.setTimeout(240_000);
    const tag = randomUUID().slice(0, 8);
    const name = `store-pages-kb-${tag}`;
    const title = "Handbuch";
    const agentName = `store_pages_agent_${tag}`;
    const agentTitle = `Handbook helper ${tag}`;
    const path = `/build/knowledge-bases/${name}`;
    const assetUrl = `${knowledgeApiUrl}/api/v1/assets/knowledge_base/${name}`;
    const agentUrl = `${knowledgeApiUrl}/api/v1/assets/agent/${agentName}`;
    const grants: string[] = [];
    let holderId: string | undefined;
    await signIn(page, apiOrigin);
    await signIn(page, knowledgeApiUrl);
    try {
      // A Knowledge Base that keeps documents, published.
      const created = await requestWithOrigin(page, "put", assetUrl, {
        data: {
          expectedRevision: null,
          config: {
            name,
            title,
            description: "The staff handbook and its appendices.",
            methods: ["keyword"]
          }
        }
      });
      expect(created.ok(), await created.text()).toBe(true);
      const published = await requestWithOrigin(page, "post", `${assetUrl}/publish`, {
        data: revisionSchema.parse(await created.json())
      });
      expect(published.ok(), await published.text()).toBe(true);
      await expect
        .poll(
          async () =>
            (
              await page.request.get(`${knowledgeApiUrl}/api/v1/knowledge-bases/${name}/documents`)
            ).status(),
          { timeout: 90_000 }
        )
        .toBe(200);

      // A live agent that searches it.
      const agent = await requestWithOrigin(page, "put", agentUrl, {
        data: {
          expectedRevision: null,
          availableIn: "all",
          config: {
            name: agentName,
            displayName: agentTitle,
            modelProviderId: "local",
            instructions: "Answer from the staff handbook.",
            toolNames: [],
            knowledgeBases: [name]
          }
        }
      });
      expect(agent.ok(), await agent.text()).toBe(true);
      // A new agent is already live; publishing here would ask for a draft that does not exist.
      expect((await page.request.get(agentUrl)).ok()).toBe(true);

      // A separate member receives knowledge_base.use; nobody may grant themselves rights.
      const createdHolder = await requestWithOrigin(
        page,
        "post",
        `${knowledgeApiUrl}/api/v1/instance/users`,
        {
          data: {
            displayLabel: "Handbook reader",
            email: `store-pages-holder-${tag}@example.test`,
            roles: ["user"]
          }
        }
      );
      expect(createdHolder.ok(), await createdHolder.text()).toBe(true);
      holderId = idSchema.parse(await createdHolder.json()).id;
      const assetId = idSchema.parse(await (await page.request.get(assetUrl)).json()).id;
      const granted = await requestWithOrigin(
        page,
        "post",
        `${knowledgeApiUrl}/api/v1/instance/access/grants`,
        {
          data: {
            holderKind: "user",
            holderId,
            action: "knowledge_base.use",
            effect: "allow",
            scopeKind: "asset",
            scopeId: assetId
          }
        }
      );
      expect(granted.ok(), await granted.text()).toBe(true);
      grants.push(idSchema.parse(await granted.json()).id);

      // The interface talks to the API with the module on.
      await page.route(`${apiOrigin}/**`, (route) =>
        route.continue({ url: route.request().url().replace(apiOrigin, knowledgeApiUrl) })
      );

      // The page in both languages and themes at 390: the agent and the holder are real.
      await page.setViewportSize(PHONE);
      for (const locale of LOCALES) {
        for (const theme of THEMES) {
          await view(page, path, title, locale, theme);
          const agentRow = page.locator(`[data-knowledge-agent="${agentName}"]`);
          await expect(agentRow).toContainText(agentTitle);
          await expect(agentRow.locator("a")).toHaveAttribute("href", `/build/agents/${agentName}`);
          await expect(
            page.getByRole("heading", { name: WORDS[locale].kbAgents, exact: true })
          ).toBeVisible();
          await expect(page.locator('[data-holder-kind="person"]').first()).toBeVisible();
          await expect(
            page.getByRole("heading", { name: WORDS[locale].kbAccess, exact: true })
          ).toBeVisible();
          await agentRow.scrollIntoViewIfNeeded();
          await noSidewaysScroll(page);
          await picture(page, `kb-page-${locale}-${theme}-390`);
        }
      }

      // In a window 640 high the page scrolls to the holders and back to the head.
      await page.setViewportSize(SHORT_PHONE);
      await view(page, path, title, "en", "light");
      await pinnedHead(page, title);
      const holder = page.locator('[data-holder-kind="person"]').first();
      await holder.scrollIntoViewIfNeeded();
      await expect(holder).toBeInViewport();
      await picture(page, "kb-scroll-holders-en-light-390x640");
      await page.getByRole("heading", { name: title, level: 1 }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("heading", { name: title, level: 1 })).toBeInViewport();
      await noSidewaysScroll(page);

      // "Edit with the agent" opens the dock beside its page, about the Knowledge Base.
      await page.setViewportSize(WIDE);
      await view(page, path, title, "en", "light");
      await page.getByRole("button", { name: EDIT, exact: true }).click();
      await expect(page).toHaveURL((url) => url.pathname === path && url.searchParams.has("chat"));
      const dockHead = page.getByTestId("dock-head");
      await expect(dockHead).toHaveAttribute("data-subject-kind", "knowledge_base");
      await expect(dockHead).toContainText(`Working on: ${title}`);
      await expect(page.getByText("Describe it", { exact: true })).toBeVisible();
      await expect(page.getByText("Give it to an agent", { exact: true })).toBeVisible();
      await picture(page, "kb-agent-en-light-1280");

      // The row on the list. The first page of documents answers a summary the instance only
      // has after ingestion; it is planted here, ingestion still running, to show each fact.
      await page.route(
        (url) =>
          url.pathname === `/api/v1/knowledge-bases/${name}/documents` &&
          url.searchParams.get("limit") === "1",
        (route) =>
          route.fulfill({
            json: {
              documents: [],
              summary: { count: 12, state: "pending", lastIngestedAt: "2026-10-17T09:30:00.000Z" }
            }
          })
      );
      await page.setViewportSize(PHONE);
      for (const locale of LOCALES) {
        for (const theme of THEMES) {
          await view(page, "/build/knowledge-bases", WORDS[locale].kbList, locale, theme);
          await page.getByRole("searchbox", { name: WORDS[locale].kbSearch }).fill(name);
          const facts = page.locator(`[data-knowledge-row-documents="${name}"]`);
          await expect(facts).toContainText(WORDS[locale].documents);
          await expect(facts).toContainText(WORDS[locale].lastIngested);
          // A list moment has no seconds.
          await expect(facts).not.toContainText(/\d:\d\d:\d\d/u);
          await expect(facts.getByText(WORDS[locale].lastIngested, { exact: false })).toBeVisible();
          await expect(page.locator('[data-knowledge-row-state="ingesting"]')).toContainText(
            WORDS[locale].ingesting
          );
          await noSidewaysScroll(page);
          await picture(page, `kb-row-${locale}-${theme}-390`);
        }
      }
    } finally {
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "ignoreErrors" });
      for (const grantId of grants) {
        await requestWithOrigin(
          page,
          "delete",
          `${knowledgeApiUrl}/api/v1/instance/access/grants/${grantId}`
        );
      }
      for (const url of [agentUrl, assetUrl]) {
        if ((await page.request.get(url)).ok()) {
          await requestWithOrigin(page, "post", `${url}/delete`, {
            data: { expectedRevision: await assetRevision(page, url) }
          });
        }
      }
      if (holderId !== undefined) {
        await requestWithOrigin(
          page,
          "delete",
          `${knowledgeApiUrl}/api/v1/instance/users/${holderId}`
        );
      }
    }
  });
});
