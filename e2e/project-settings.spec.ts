import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// PRJ-6: a person shares their private project with a workspace, a member writes in it, and
// the person makes it private again: the member's chat leaves it. The person then moves it to
// another workspace of theirs and deletes it with its chats. In German.

const creator = {
  email: "e2e-project-settings@example.test",
  password: "e2e-project-settings-password"
};
const member = {
  email: "e2e-project-settings-member@example.test",
  password: "e2e-project-settings-member-password"
};
const idSchema = z.object({ id: z.string() });
const shotsDir = process.env.E2E_SHOTS_DIR;

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
}

/** The page at 1280 and 390, with the dialog that is open. */
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

async function workspace(page: Page, name: string): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name, defaultConversationVisibility: "workspace" }
  });
  expect(created.ok()).toBe(true);
  return idSchema.parse(await created.json()).id;
}

async function openSetting(page: Page, item: RegExp): Promise<void> {
  await page.getByRole("button", { name: "Weitere Aktionen" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function startChatInProject(page: Page, title: string, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: `Neuer Chat in ${title}` });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);
  await expect(page.getByText(text).first()).toBeVisible();
}

test("a person shares a project, makes it private again, moves it and deletes it", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(90_000);
  const suffix = String(Date.now());
  const title = `Angebot Hafen ${suffix}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await Promise.all([signIn(page, creator), signIn(memberPage, member)]);

  const team = await workspace(page, `Vertrieb ${suffix}`);
  const second = await workspace(page, `Planung ${suffix}`);
  const added = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/workspaces/${team}/members`,
    { data: { email: member.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);

  // A private project with a chat of its creator.
  await page.goto(`/w/${team}/projects`);
  await page.getByRole("button", { name: "Neues Projekt" }).click();
  const create = page.getByRole("dialog", { name: "Neues Projekt" });
  await create.getByLabel("Name").fill(title);
  await create.getByRole("radio", { name: "Nur ich" }).check();
  await create.getByRole("button", { name: "Projekt anlegen" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const projectPath = new URL(page.url()).pathname;
  await startChatInProject(page, title, "Welche Unterlagen fehlen noch?");
  await memberPage.goto(`/w/${team}/projects`);
  await expect(memberPage.getByText(title)).toHaveCount(0);

  // Shared with the workspace: the member sees it and writes in it.
  await page.goto(projectPath);
  await openSetting(page, /^Mit Arbeitsbereich teilen$/u);
  const share = page.getByRole("dialog", { name: `${title} mit Vertrieb ${suffix} teilen?` });
  await expect(share).toContainText("1 Chat");
  await shot(page, "project-share-dialog");
  await share.getByRole("button", { name: "Teilen" }).click();
  await expect(share).toBeHidden();
  await expect(page.getByTestId("project-audience-shared")).toBeVisible();
  await memberPage.goto(projectPath);
  await expect(memberPage.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(memberPage.getByTestId("project-conversation")).toHaveCount(1);
  await startChatInProject(memberPage, title, "Ich ergänze die Grundrisse.");

  // Private again: the member's chat leaves the project, which the dialog says first.
  await page.goto(projectPath);
  await expect(page.getByTestId("project-conversation")).toHaveCount(2);
  await openSetting(page, /^Privat machen$/u);
  const hide = page.getByRole("dialog", { name: `${title} privat machen?` });
  await expect(hide.getByTestId("project-audience-others")).toContainText("1 Chat von anderen");
  await shot(page, "project-private-dialog");
  await hide.getByRole("button", { name: "Privat machen" }).click();
  await expect(hide).toBeHidden();
  await expect(page.getByTestId("project-audience-private")).toBeVisible();
  await expect(page.getByTestId("project-conversation")).toHaveCount(1);
  await memberPage.goto(`/w/${team}/projects`);
  await expect(memberPage.getByText(title)).toHaveCount(0);
  await memberContext.close();

  // Moved to the person's other workspace with its chat.
  await openSetting(page, /^In Arbeitsbereich verschieben/u);
  const move = page.getByRole("dialog", {
    name: `${title} in einen anderen Arbeitsbereich verschieben`
  });
  await move.getByRole("radio", { name: `Planung ${suffix}` }).check();
  await expect(move.getByTestId("project-move-audience")).toContainText("Nur ich");
  await shot(page, "project-move-dialog");
  await move.getByRole("button", { name: "Verschieben" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${second}/p/[^/]+$`, "u"));
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByTestId("project-conversation")).toHaveCount(1);

  // Deleted with its chat.
  await openSetting(page, /^Löschen/u);
  const remove = page.getByRole("dialog", { name: `${title} löschen?` });
  await expect(remove.getByRole("radio", { name: /^In Planung/u })).toBeChecked();
  await remove.getByRole("radio", { name: /^Ebenfalls löschen/u }).check();
  await shot(page, "project-delete-dialog");
  await remove.getByRole("button", { name: "Projekt löschen" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${second}/projects$`, "u"));
  await expect(page.getByText(title)).toHaveCount(0);
  await shot(page, "projects-after-delete");
});
