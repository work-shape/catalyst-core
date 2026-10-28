import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// PRJ-7: a project's default agent and skills. On the page of a project the workspace reads, the
// "Skills & Agent" tile opens the panel: the person's own agent and own skill are greyed there
// with the reason and "Mit <Team> teilen…". A workspace agent becomes the default and a team
// skill is attached; the own skill is shared with the team from the chooser and then attached
// too. The composer's agent chooser starts on the default, and the new chat runs with it. In
// German. Fails where an own agent or skill can be chosen for a project others read, where the
// share does not open it, or where a new chat ignores the project's default.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

const TAG = Date.now().toString(36);
const TEAM = `Projektteam ${TAG}`;
const PROJECT = `Neubau ${TAG}`;
const OWN_AGENT = `own_project_${TAG}`;
const OWN_AGENT_TITLE = `Mein Entwurf ${TAG}`;
const OWN_SKILL = `own_skill_${TAG}`;
const OWN_SKILL_TITLE = `Meine Checkliste ${TAG}`;
const TEAM_SKILL = `team_skill_${TAG}`;
const TEAM_SKILL_TITLE = `Objektprüfung ${TAG}`;
const REASON = "Nur du kannst ihn nutzen, und das Projekt liest der ganze Workspace.";

const idSchema = z.object({ id: z.string() });
const workspaceListSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string() }))
});
const setupSchema = z.object({
  defaultAgent: z.string().optional(),
  skills: z.array(z.string()),
  workspaceDefaultAgent: z.string().optional(),
  agents: z.array(
    z.object({
      name: z.string(),
      displayName: z.string(),
      own: z.boolean(),
      refusal: z.string().optional()
    })
  )
});
const projectSchema = z.object({ id: z.string() });

/** The person's Personal Workspace, which the first visit of the interface sets up. */
async function personalWorkspace(page: Page): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      const response = await page.request.get(`${apiBaseUrl}/api/v1/workspaces?limit=100`);
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

async function put(page: Page, kind: "agent" | "skill", name: string, data: object) {
  const stored = await requestWithOrigin(
    page,
    "put",
    `${apiBaseUrl}/api/v1/assets/${kind}/${name}`,
    {
      data: { expectedRevision: null, ...data }
    }
  );
  expect(stored.ok(), await stored.text()).toBe(true);
}

async function remove(page: Page, kind: "agent" | "skill", name: string, workspaceIds: string[]) {
  for (const workspaceId of workspaceIds) {
    const path = `${apiBaseUrl}/api/v1/assets/${kind}/${name}`;
    const current = await page.request.get(`${path}?workspaceId=${workspaceId}`);
    if (!current.ok()) continue;
    const { revision } = z.object({ revision: z.number() }).parse(await current.json());
    await requestWithOrigin(page, "post", `${path}/delete`, {
      data: { expectedRevision: revision, workspaceId }
    });
  }
}

/** One picture at desktop and one at phone width, where `E2E_SHOTS_DIR` names a folder. */
async function shot(page: Page, name: string, ready: () => Promise<unknown>): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
    await ready();
    await page.screenshot({
      path: join(shotsDir, `prj-7-${name}-de-${String(width)}.png`),
      animations: "disabled"
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

test("a project's default agent and skills take only what its audience may use, and a new chat starts with the default", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 240_000 : 150_000);
  await signIn(page, superadmin);
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.setViewportSize({ width: 1280, height: 860 });
  const personalId = await personalWorkspace(page);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: TEAM, defaultConversationVisibility: "workspace" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const teamId = idSchema.parse(await created.json()).id;
  await put(page, "agent", OWN_AGENT, {
    workspaceId: personalId,
    config: {
      name: OWN_AGENT,
      displayName: OWN_AGENT_TITLE,
      description: "Schreibt meine Entwürfe.",
      instructions: "Antworte knapp."
    }
  });
  await put(page, "skill", OWN_SKILL, {
    workspaceId: personalId,
    config: {
      name: OWN_SKILL,
      title: OWN_SKILL_TITLE,
      description: "Use when a draft is checked before it is sent.",
      content: "# Checkliste\n\nPrüfe Adresse, Datum und Betrag."
    }
  });
  await put(page, "skill", TEAM_SKILL, {
    workspaceId: teamId,
    config: {
      name: TEAM_SKILL,
      title: TEAM_SKILL_TITLE,
      description: "Use when a property is checked for the sales team.",
      content: "# Objektprüfung\n\nPrüfe Lage, Baujahr und Energieausweis."
    }
  });

  try {
    await page.goto(`/w/${teamId}/projects`);
    await page.getByRole("button", { name: "Neues Projekt" }).click();
    const dialog = page.getByRole("dialog", { name: "Neues Projekt" });
    await dialog.getByLabel("Name").fill(PROJECT);
    await dialog.getByRole("radio", { name: /^Geteilt mit/u }).check();
    await dialog.getByRole("button", { name: "Projekt anlegen" }).click();
    await expect(page.getByRole("heading", { level: 1, name: PROJECT })).toBeVisible();
    const projectName = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    const project = projectSchema.parse(
      await (await page.request.get(`${apiBaseUrl}/api/v1/projects/${projectName}`)).json()
    );
    const setupPath = `${apiBaseUrl}/api/v1/project-settings/${project.id}/setup`;
    const before = setupSchema.parse(await (await page.request.get(setupPath)).json());
    // A workspace agent other than the one new chats take anyway.
    const agent = before.agents.find(
      (entry) => !entry.own && !entry.refusal && entry.name !== before.workspaceDefaultAgent
    );
    expect(agent, JSON.stringify(before.agents)).toBeDefined();
    if (!agent) return;

    // The tile beside the instructions: nothing attached yet.
    const tile = page.getByTestId("project-setup-tile");
    await expect(tile).toHaveAttribute("data-state", "empty");
    await expect(tile).toContainText("Keine Skills.");
    await shot(page, "tiles-empty", () => expect(tile).toBeVisible());

    // The panel: the own agent is greyed with the reason and the share into the team.
    await tile.getByRole("button", { name: "Skills und Agent öffnen" }).click();
    const panel = page.getByTestId("project-setup-panel");
    await expect(panel).toContainText(`Ein neuer Chat in ${PROJECT} startet mit diesem Agenten`);
    const agentTrigger = page.getByTestId("project-setup-agent");
    const ownAgent = await openPicker(page, agentTrigger, OWN_AGENT_TITLE);
    // Greyed with a step instead: choosing the row opens the share, never sets the agent.
    await expect(ownAgent).toHaveAttribute("data-picker-action", "");
    await expect(ownAgent).toContainText(REASON);
    await expect(ownAgent).toContainText(`Mit ${TEAM} teilen…`);
    await shot(page, "agent-greyed", () => openPicker(page, agentTrigger, OWN_AGENT_TITLE));
    await option(page, agent.displayName).first().click();
    await expect(agentTrigger).toContainText(agent.displayName);

    // The team's skill is attached; the own one is greyed in the same way.
    const skillsTrigger = page.getByTestId("project-setup-add-skills");
    await (await openPicker(page, skillsTrigger, TEAM_SKILL_TITLE)).click();
    const ownSkill = option(page, OWN_SKILL_TITLE);
    await expect(ownSkill).toHaveAttribute("data-picker-action", "");
    await expect(ownSkill).toContainText(REASON);
    await shot(page, "skill-greyed", () => openPicker(page, skillsTrigger, OWN_SKILL_TITLE));
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-setup-skills")).toContainText(TEAM_SKILL_TITLE);
    await page.getByTestId("project-setup-save").click();
    await expect(panel).toContainText("Gespeichert.");
    const saved = setupSchema.parse(await (await page.request.get(setupPath)).json());
    expect(saved.defaultAgent).toBe(agent.name);
    expect(saved.skills).toEqual([TEAM_SKILL]);

    // Shared with the team from the chooser, the own skill can be attached.
    await (await openPicker(page, skillsTrigger, OWN_SKILL_TITLE)).click();
    const share = page.getByRole("dialog", { name: `„${OWN_SKILL_TITLE}“ teilen` });
    await expect(share).toBeVisible();
    await share.getByRole("button", { name: "Teilen", exact: true }).click();
    await expect(share).toHaveCount(0);
    const shared = await openPicker(page, skillsTrigger, OWN_SKILL_TITLE);
    await expect(shared).not.toHaveAttribute("data-picker-action");
    await shared.click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-setup-skills")).toContainText(OWN_SKILL_TITLE);
    await page.getByTestId("project-setup-save").click();
    await expect(panel).toContainText("Gespeichert.");
    await shot(page, "panel", () => expect(panel).toBeVisible());
    expect(setupSchema.parse(await (await page.request.get(setupPath)).json()).skills).toEqual([
      TEAM_SKILL,
      OWN_SKILL
    ]);
    await page.keyboard.press("Escape");
    await expect(tile).toHaveAttribute("data-state", "set");
    await expect(tile).toContainText(TEAM_SKILL_TITLE);
    await expect(tile).toContainText(agent.displayName);

    // The composer starts on the default, and the new chat runs with it.
    const composerAgent = page.getByTestId("project-composer-agent");
    await expect(composerAgent).toHaveAccessibleName(`Agent des neuen Chats: ${agent.displayName}`);
    await shot(page, "page", () => expect(composerAgent).toBeVisible());
    const run = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/v1/conversations/runs"
    );
    const composer = page.getByRole("textbox", { name: `Neuer Chat in ${PROJECT}` });
    await composer.fill(`Objekt prüfen ${TAG}`);
    await composer.press("Enter");
    // Left as preselected, the browser names no agent: the server starts with the project's.
    const body = z
      .object({ agentName: z.string().optional() })
      .passthrough()
      .parse((await run).postDataJSON());
    expect(body).toMatchObject({ conversation: { projectId: project.id } });
    expect(body.agentName).toBeUndefined();
    await expect(page).toHaveURL(/\/c\/[^/]+$/u);
    await expect(
      page.locator("header").getByRole("button", { name: `Agent auswählen: ${agent.displayName}` })
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await remove(page, "agent", OWN_AGENT, [personalId]);
    await remove(page, "skill", OWN_SKILL, [personalId, teamId]);
    await remove(page, "skill", TEAM_SKILL, [teamId]);
  }
});
