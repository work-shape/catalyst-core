import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// PRJ-5: a person with projects in two workspaces sees the open workspace's recent projects in
// the rail, all of them on the Projects page under "Alle meine Arbeitsbereiche" with each
// card's workspace chip, and opening one of the other workspace switches to it. A member of one
// workspace sees its shared project only. In German.

const owner = { email: "e2e-projects-all@example.test", password: "e2e-projects-all-password" };
const member = {
  email: "e2e-projects-all-member@example.test",
  password: "e2e-projects-all-member-password"
};
const idSchema = z.object({ id: z.string() });
const projectSchema = z.object({ id: z.string(), name: z.string() });
const shotsDir = process.env.E2E_SHOTS_DIR;

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // The story is told in German, and starts on this workspace's projects.
  await page.addInitScript(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
  });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.screenshot({
      path: join(shotsDir, `${name}-de-${String(width)}.png`),
      animations: "disabled"
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function createWorkspace(page: Page, name: string): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name, defaultConversationVisibility: "workspace" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  return idSchema.parse(await created.json()).id;
}

async function createProject(
  page: Page,
  workspaceId: string,
  title: string,
  audience: "workspace" | "private"
): Promise<z.infer<typeof projectSchema>> {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/projects`, {
    data: { collaborationWorkspaceId: workspaceId, title, audience }
  });
  expect(created.ok(), await created.text()).toBe(true);
  return projectSchema.parse(await created.json());
}

async function startChat(page: Page, workspaceId: string, projectId: string, text: string) {
  const started = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/conversations/runs`, {
    data: {
      idempotencyKey: randomUUID(),
      conversation: { collaborationWorkspaceId: workspaceId, projectId },
      message: { text }
    }
  });
  expect(started.ok(), await started.text()).toBe(true);
}

test("all projects: the rail group, the scope filter with workspace chips, and a switch on open", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(60_000);
  // Its own per run: runs side by side share the two people.
  const suffix = randomUUID().slice(0, 6);
  const sales = `Vertrieb ${suffix}`;
  const finance = `Finanzierung ${suffix}`;
  const sharedTitle = `Hoheluft Neubau ${suffix}`;
  const privateTitle = `Notizen Anna ${suffix}`;
  const otherTitle = `Kreditprüfung ${suffix}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await Promise.all([signIn(page, owner), signIn(memberPage, member)]);

  // Two workspaces of the owner; the member belongs to the first only.
  const salesId = await createWorkspace(page, sales);
  const financeId = await createWorkspace(page, finance);
  const added = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/workspaces/${salesId}/members`,
    { data: { email: member.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);
  const shared = await createProject(page, salesId, sharedTitle, "workspace");
  await createProject(page, salesId, privateTitle, "private");
  const other = await createProject(page, financeId, otherTitle, "workspace");
  await startChat(page, salesId, shared.id, "Was fehlt noch in der Checkliste?");
  await startChat(page, financeId, other.id, "Welche Unterlagen braucht die Bank?");

  // The rail lists the open workspace's projects, the private one with its lock.
  await page.goto(`/w/${salesId}/projects`);
  const railGroup = page.getByTestId("rail-projects");
  await expect(railGroup.getByTestId("rail-project")).toHaveCount(2);
  await expect(railGroup.getByTestId("rail-project").filter({ hasText: sharedTitle })).toHaveCount(
    1
  );
  await expect(
    railGroup
      .getByTestId("rail-project")
      .filter({ hasText: privateTitle })
      .getByTestId("rail-project-private")
  ).toBeVisible();
  await expect(railGroup.getByText(otherTitle)).toHaveCount(0);
  await expect(railGroup.getByTestId("rail-projects-all")).toHaveText("Alle Projekte");
  await expect(page.getByTestId("project-card")).toHaveCount(2);

  // The plus of the group makes a project in the open workspace.
  await railGroup.getByRole("button", { name: "Projekt hinzufügen" }).click();
  const dialog = page.getByRole("dialog", { name: "Neues Projekt" });
  await expect(dialog).toContainText(sales);
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(dialog).toBeHidden();
  await shot(page, "projects-this-workspace");

  // Across workspaces: one group per workspace, each card with its workspace's chip.
  await page.getByRole("radio", { name: "Alle meine Arbeitsbereiche" }).click();
  // The people may hold workspaces of an earlier run on the same database: only this run's
  // workspaces are counted, the open one first.
  const groups = page.getByTestId("projects-workspace-group");
  await expect(groups.first()).toContainText(sales);
  await expect(groups.filter({ hasText: sales }).getByTestId("project-card")).toHaveCount(2);
  await expect(groups.filter({ hasText: finance }).getByTestId("project-card")).toHaveCount(1);
  const otherCard = page.getByTestId("project-card").filter({ hasText: otherTitle });
  await expect(otherCard).toContainText(finance);
  await expect(otherCard).toContainText("1 Chat");
  await shot(page, "projects-all-workspaces");

  // Opening the other workspace's project switches to that workspace.
  await otherCard.getByRole("link", { name: `${otherTitle} öffnen` }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${financeId}/p/${other.name}$`, "u"));
  await expect(page.getByRole("heading", { level: 1, name: otherTitle })).toBeVisible();
  await expect(page.getByTestId("project-conversation")).toHaveCount(1);
  await expect(page.getByTestId("collaboration-workspace-selector-trigger")).toContainText(finance);
  const switchedRail = page.getByTestId("rail-projects").getByTestId("rail-project");
  await expect(switchedRail).toHaveCount(1);
  await expect(switchedRail).toHaveAttribute("aria-current", "true");
  await shot(page, "project-opened-in-other-workspace");

  // The scope stays when the person comes back; the member sees the shared project only.
  await page.goto(`/w/${financeId}/projects`);
  await expect(page.getByRole("radio", { name: "Alle meine Arbeitsbereiche" })).toBeChecked();
  await memberPage.goto(`/w/${salesId}/projects`);
  await memberPage.getByRole("radio", { name: "Alle meine Arbeitsbereiche" }).click();
  const memberCards = memberPage.getByTestId("project-card").filter({ hasText: suffix });
  await expect(memberCards).toHaveCount(1);
  await expect(memberCards).toContainText(sharedTitle);
  await expect(memberPage.getByText(privateTitle)).toHaveCount(0);
  await expect(memberPage.getByText(otherTitle)).toHaveCount(0);
  await expect(memberPage.getByTestId("rail-project")).toHaveCount(1);
  await shot(memberPage, "projects-all-workspaces-member");
  await memberContext.close();
});
