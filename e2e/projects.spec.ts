import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// PRJ-1: a person makes a shared and a private project in a workspace of theirs, starts a chat
// in each and moves an older one into the shared project. A second member sees the shared
// project with its two chats and not the private one, also not by its link. In German.

const NOT_FOUND_TEST = "a member sees the shared project with its chats and not the private one";

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "private-project-by-link",
        reason:
          "The member opens the private project's link; the server answers it as a project that does not exist, asserted on the page below.",
        matches: requestAnswered(404),
        path: /^\/api\/v1\/projects\/[^/]+$/u,
        tests: [NOT_FOUND_TEST]
      }
    ]
  }
});

const creator = { email: "e2e-projects@example.test", password: "e2e-projects-password" };
const member = {
  email: "e2e-projects-member@example.test",
  password: "e2e-projects-member-password"
};
const idSchema = z.object({ id: z.string() });
const shotsDir = process.env.E2E_SHOTS_DIR;

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // The story is told in German. The first page makes the person's account in the product.
  await page.addInitScript(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
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

/** Makes a project on the Projects page and answers the address of its page. */
async function createProject(
  page: Page,
  workspaceId: string,
  title: string,
  audience: "Nur ich" | RegExp
): Promise<string> {
  await page.goto(`/w/${workspaceId}/projects`);
  await page.getByRole("button", { name: "Neues Projekt" }).click();
  const dialog = page.getByRole("dialog", { name: "Neues Projekt" });
  await dialog.getByLabel("Name").fill(title);
  await dialog.getByRole("radio", { name: audience }).check();
  await dialog.getByRole("button", { name: "Projekt anlegen" }).click();
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/p/[^/]+$`, "u"));
  return new URL(page.url()).pathname;
}

/** Starts a chat in the project on screen with the composer, and waits until it is open. */
async function startChatInProject(page: Page, title: string, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: `Neuer Chat in ${title}` });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);
  await expect(page.getByText(text).first()).toBeVisible();
}

test(NOT_FOUND_TEST, async ({ page, browser, baseURL, pageErrors }) => {
  test.setTimeout(60_000);
  const suffix = Date.now();
  const sharedTitle = `Neubau Nord ${String(suffix)}`;
  const privateTitle = `Notizen Anna ${String(suffix)}`;
  const olderTitle = `Bauzeitenplan ${String(suffix)}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  // Both sign in first: a person is added to a workspace once they have signed in.
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await Promise.all([signIn(page, creator), signIn(memberPage, member)]);

  // A workspace of the creator with the second person as a member, and an older chat in it.
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: `Projektteam ${String(suffix)}`, defaultConversationVisibility: "workspace" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const added = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/workspaces/${workspaceId}/members`,
    { data: { email: member.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);
  const older = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/conversations/runs`, {
    data: {
      idempotencyKey: randomUUID(),
      conversation: { title: olderTitle, collaborationWorkspaceId: workspaceId },
      message: { text: "Wann beginnt der Rohbau?" }
    }
  });
  expect(older.ok()).toBe(true);

  // Projects have no section row: the group "Projekte" is their place in the rail, and without
  // a project it shows its label with the plus alone.
  await page.goto(`/w/${workspaceId}`);
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav.getByRole("button", { name: "Projekte", exact: true })).toHaveCount(0);
  const railGroup = page.getByTestId("rail-projects");
  await expect(railGroup).toContainText("Projekte");
  await expect(railGroup.getByTestId("rail-projects-all")).toHaveCount(0);
  await shot(page, "projects-rail-empty");

  // Its plus makes the first project; the creator makes a shared and a private one.
  await railGroup.getByRole("button", { name: "Projekt hinzufügen" }).click();
  await expect(page.getByRole("dialog", { name: "Neues Projekt" })).toBeVisible();
  await page
    .getByRole("dialog", { name: "Neues Projekt" })
    .getByRole("button", { name: "Abbrechen" })
    .click();
  const sharedPath = await createProject(page, workspaceId, sharedTitle, /^Geteilt mit/u);
  await expect(page.getByTestId("project-audience-shared")).toBeVisible();
  await startChatInProject(page, sharedTitle, "Was fehlt noch in der Checkliste?");

  const privatePath = await createProject(page, workspaceId, privateTitle, "Nur ich");
  await expect(page.getByTestId("project-audience-private")).toBeVisible();
  await startChatInProject(page, privateTitle, "Meine eigenen Notizen zum Termin");

  // The older chat moves into the shared project from its menu in the rail.
  const olderRow = page.getByTestId("conversation-row").filter({ hasText: olderTitle });
  await olderRow.getByRole("button", { name: `Optionen für Unterhaltung ${olderTitle}` }).click();
  await page.getByRole("menuitem", { name: "In Projekt verschieben…" }).click();
  const moveDialog = page.getByRole("dialog", { name: "In Projekt verschieben" });
  await moveDialog.getByRole("radio", { name: new RegExp(sharedTitle, "u") }).check();
  await moveDialog.getByRole("button", { name: "Verschieben" }).click();
  await expect(moveDialog).toBeHidden();
  await expect(olderRow.getByTestId("conversation-project-marker")).toBeVisible();

  await page.goto(sharedPath);
  await expect(page.getByTestId("project-conversation")).toHaveCount(2);
  await expect(
    page.getByTestId("project-conversation").filter({ hasText: olderTitle })
  ).toHaveCount(1);
  await shot(page, "project-shared");
  // "Alle Projekte" in the group opens the page.
  await railGroup.getByTestId("rail-projects-all").click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/projects$`, "u"));
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await shot(page, "projects-creator");

  // On a phone the drawer holds the same group, with its plus and the row to all projects.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Seitenleiste öffnen" }).click();
  const drawer = page.getByRole("dialog", { name: "Hauptnavigation" });
  const drawerGroup = drawer.getByTestId("rail-projects");
  await expect(drawerGroup.getByTestId("rail-project")).toHaveCount(2);
  await expect(drawerGroup.getByRole("button", { name: "Projekt hinzufügen" })).toBeVisible();
  await expect(drawerGroup.getByTestId("rail-projects-all")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Projekte", exact: true })).toHaveCount(0);
  if (shotsDir) {
    await page.screenshot({ path: join(shotsDir, "projects-drawer-de-390.png") });
  }
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });

  // The member sees the shared project with its two chats, and not the private one.
  await memberPage.goto(`/w/${workspaceId}/projects`);
  await expect(memberPage.getByTestId("project-card")).toHaveCount(1);
  await expect(memberPage.getByTestId("project-card")).toContainText(sharedTitle);
  await expect(memberPage.getByText(privateTitle)).toHaveCount(0);
  await shot(memberPage, "projects-member");

  await memberPage.goto(sharedPath);
  await expect(memberPage.getByTestId("project-conversation")).toHaveCount(2);

  // By its link the private project does not exist for the member.
  await memberPage.goto(privatePath);
  await expect(memberPage.getByTestId("project-not-found")).toBeVisible();
  await expect(memberPage.getByText(privateTitle)).toHaveCount(0);
  await shot(memberPage, "project-private-by-link");
  await memberContext.close();
});
