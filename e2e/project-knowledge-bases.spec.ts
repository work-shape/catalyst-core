import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, takeTurn, test } from "./test";

// PRJ-8: a project's Knowledge Bases. On the page of a project the team reads, the
// "Wissensbasen" item of its "…" menu opens the panel: the person's own Knowledge Base is greyed
// with the reason and "Mit <Team> teilen…", one the team may not use with "Nicht alle in <Team>
// dürfen sie nutzen.". The team's is attached and saved. Taken out of the team, it stays listed
// as not applying, and the page warns of it. In German. The suite's
// instance runs without the module `knowledge`, so a second API runs it with the module on, on
// the same database, as knowledge-upload.spec.ts does.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const configPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

/** The API with `knowledge` on listens beside the suite's own, on a port no other spec takes. */
const knowledgeApiPort = Number(new URL(apiBaseUrl).port) + 23;
const knowledgeApiUrl = `http://${host}:${knowledgeApiPort}`;

const TAG = Date.now().toString(36);
const TEAM = `Wissensteam ${TAG}`;
const PROJECT = `Bauakte ${TAG}`;
const TEAM_KB = `team-kb-${TAG}`;
const TEAM_KB_TITLE = `Bauvorschriften ${TAG}`;
const OWN_KB = `own-kb-${TAG}`;
const OWN_KB_TITLE = `Meine Notizen ${TAG}`;
const OPEN_KB = `open-kb-${TAG}`;
const OPEN_KB_TITLE = `Hausregeln ${TAG}`;
const OWN_REASON = "Nur du kannst sie nutzen, und das Projekt liest der ganze Workspace.";

const idSchema = z.object({ id: z.string() });
const workspaceListSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string() }))
});
const setupSchema = z.object({ knowledgeBases: z.array(z.string()) });
const projectSchema = z.object({ id: z.string() });

async function signIn(page: Page, api: string): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** The person's Personal Workspace, which the first visit of the interface sets up. */
async function personalWorkspace(page: Page): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      const response = await page.request.get(`${knowledgeApiUrl}/api/v1/workspaces?limit=100`);
      if (!response.ok()) return "";
      id =
        workspaceListSchema
          .parse(await response.json())
          .items.find((workspace) => workspace.kind === "personal")?.id ?? "";
      return id;
    })
    .not.toBe("");
  return id;
}

const kbUrl = (name: string) => `${knowledgeApiUrl}/api/v1/assets/knowledge_base/${name}`;

/** A published Knowledge Base, of a workspace or of the instance. */
async function knowledgeBase(page: Page, name: string, title: string, workspaceId?: string) {
  const where = workspaceId ? { workspaceId } : {};
  const created = await requestWithOrigin(page, "put", kbUrl(name), {
    data: {
      expectedRevision: null,
      ...where,
      config: { name, title, description: `Was in ${title} steht.`, methods: ["keyword"] }
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const published = await requestWithOrigin(page, "post", `${kbUrl(name)}/publish`, {
    data: { revision: 1, ...where }
  });
  expect(published.ok(), await published.text()).toBe(true);
}

async function availableIn(page: Page, name: string, workspaceIds: string[]) {
  const set = await requestWithOrigin(page, "put", `${kbUrl(name)}/availability`, {
    data: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: workspaceIds }
  });
  expect(set.ok(), await set.text()).toBe(true);
}

async function remove(page: Page, name: string, workspaceId?: string) {
  const query = workspaceId ? `?workspaceId=${workspaceId}` : "";
  const current = await page.request.get(`${kbUrl(name)}${query}`);
  if (!current.ok()) return;
  const { revision } = z.object({ revision: z.number() }).parse(await current.json());
  await requestWithOrigin(page, "post", `${kbUrl(name)}/delete`, {
    data: { expectedRevision: revision, ...(workspaceId ? { workspaceId } : {}) }
  });
}

/** One picture at desktop and one at phone width, where `E2E_SHOTS_DIR` names a folder. */
async function shot(page: Page, name: string, ready: () => Promise<unknown>): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
    await ready();
    await page.screenshot({
      path: join(shotsDir, `prj-8-${name}-de-${String(width)}.png`),
      animations: "disabled",
      fullPage: name === "page"
    });
  }
  await page.setViewportSize({ width: 1280, height: 860 });
}

const option = (page: Page, name: string): Locator =>
  page.getByRole("option", { name: new RegExp(name, "u") });

/** Opens a picker by its trigger where its list is not open yet. */
async function openPicker(page: Page, trigger: Locator, row: string): Promise<Locator> {
  const found = option(page, row);
  if (!(await found.isVisible())) await trigger.click();
  await expect(found).toBeVisible();
  return found;
}

test.describe("a project's Knowledge Bases", () => {
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
    const onConfigPath = resolve(dirname(resolve(configPath)), "e2e-app-project-knowledge.yaml");
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

  test("a shared project attaches only what its team may search, and keeps one that stops applying as not applying", async ({
    page
  }) => {
    test.setTimeout(shotsDir ? 240_000 : 150_000);
    await signIn(page, apiBaseUrl);
    await signIn(page, knowledgeApiUrl);
    await page.addInitScript(() => {
      window.localStorage.setItem("vivd-catalyst:locale", "de");
      window.localStorage.setItem("vivd-catalyst:theme", "light");
    });
    await page.route(`${apiBaseUrl}/**`, (route) =>
      route.continue({ url: route.request().url().replace(apiBaseUrl, knowledgeApiUrl) })
    );
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto("/");
    const personalId = await personalWorkspace(page);
    const created = await requestWithOrigin(page, "post", `${knowledgeApiUrl}/api/v1/workspaces`, {
      data: { name: TEAM, defaultConversationVisibility: "workspace" }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const teamId = idSchema.parse(await created.json()).id;
    await knowledgeBase(page, TEAM_KB, TEAM_KB_TITLE, teamId);
    await availableIn(page, TEAM_KB, [teamId]);
    await knowledgeBase(page, OWN_KB, OWN_KB_TITLE, personalId);
    // The instance's, offered in no workspace: the person may search it, the team may not.
    await knowledgeBase(page, OPEN_KB, OPEN_KB_TITLE);
    await availableIn(page, OPEN_KB, []);

    try {
      await page.goto(`/w/${teamId}/projects`);
      await page.getByRole("button", { name: "Neues Projekt" }).click();
      const dialog = page.getByRole("dialog", { name: "Neues Projekt" });
      await dialog.getByLabel("Name").fill(PROJECT);
      await dialog.getByRole("radio", { name: /^Geteilt mit/u }).check();
      await dialog.getByRole("button", { name: "Projekt anlegen" }).click();
      await expect(page.getByRole("heading", { level: 2, name: PROJECT })).toBeVisible();
      const projectName = new URL(page.url()).pathname.split("/").at(-1) ?? "";
      const project = projectSchema.parse(
        await (await page.request.get(`${knowledgeApiUrl}/api/v1/projects/${projectName}`)).json()
      );
      const setupPath = `${knowledgeApiUrl}/api/v1/project-settings/${project.id}/setup`;

      // The page's "…" menu offers the Knowledge Bases where the module is on.
      const menu = page.getByTestId("project-menu");
      const warning = page.getByTestId("project-start-knowledge-unavailable");
      const openKnowledge = async () => {
        await menu.click();
        await page.getByTestId("project-menu-knowledge").click();
      };
      await expect(menu).toBeVisible();
      await expect(warning).toHaveCount(0);
      await shot(page, "page", () => expect(menu).toBeVisible());

      // The panel: the own one greyed with the share into the team, the instance's with the reason.
      await openKnowledge();
      const panel = page.getByTestId("project-knowledge-panel");
      await expect(panel).toContainText(`Jeder Chat in ${PROJECT} durchsucht diese Wissensbasen`);
      const trigger = page.getByTestId("project-knowledge-add");
      const own = await openPicker(page, trigger, OWN_KB_TITLE);
      await expect(own).toHaveAttribute("data-picker-action", "");
      await expect(own).toContainText(OWN_REASON);
      await expect(own).toContainText(`Mit ${TEAM} teilen…`);
      const open = option(page, OPEN_KB_TITLE);
      await expect(open).toHaveAttribute("aria-disabled", "true");
      await expect(open).toContainText(`Nicht alle in ${TEAM} dürfen sie nutzen.`);
      await shot(page, "greyed", () => openPicker(page, trigger, OWN_KB_TITLE));

      // The team's is attached and saved.
      await option(page, TEAM_KB_TITLE).click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("project-knowledge-list")).toContainText(TEAM_KB_TITLE);
      await page.getByTestId("project-knowledge-save").click();
      await expect(panel).toContainText("Gespeichert.");
      expect(setupSchema.parse(await (await page.request.get(setupPath)).json())).toMatchObject({
        knowledgeBases: [TEAM_KB]
      });
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(warning).toHaveCount(0);

      // Taken out of the team, it stays attached and is listed as not applying; the page warns.
      await availableIn(page, TEAM_KB, []);
      await page.reload();
      await expect(warning).toContainText("Etwas davon gilt nicht mehr");
      await warning.getByRole("button", { name: "Öffnen" }).click();
      // Named by its title where the person may still search it, and by its name where not.
      const gone = new RegExp(`(${TEAM_KB_TITLE}|${TEAM_KB}) · gilt nicht`, "u");
      await expect(page.getByTestId("project-knowledge-list")).toContainText(gone);
      await expect(page.getByTestId("project-knowledge-unavailable")).toContainText(
        "In diesem Projekt nicht mehr durchsucht:"
      );
      await shot(page, "not-applying", () => expect(panel).toBeVisible());
    } finally {
      await remove(page, TEAM_KB, teamId);
      await remove(page, OWN_KB, personalId);
      await remove(page, OPEN_KB);
    }
  });
});
