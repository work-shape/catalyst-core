import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// PRJ-3: a project's instructions, its AGENTS.md. A person writes them on the project's page.
// A member's chat in the project takes them. The agent of the first person's chat proposes a
// change, which waits on a card that shows it and says who it applies to; Allow writes it. The
// member's chat then says the instructions changed and shows what changed. In German.

const creator = {
  email: "e2e-project-instructions@example.test",
  password: "e2e-project-instructions-password",
  label: "E2E Zz Project Instructions"
};
const member = {
  email: "e2e-project-instructions-member@example.test",
  password: "e2e-project-instructions-member-password",
  label: "E2E Zz Project Instructions Member"
};
const idSchema = z.object({ id: z.string() });
const shotsDir = process.env.E2E_SHOTS_DIR;

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { email: person.email, password: person.password, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
}

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    if (target) {
      await expect(async () => {
        await target.scrollIntoViewIfNeeded({ timeout: 2_000 });
      }).toPass();
    }
    await page.screenshot({
      path: join(shotsDir, `${name}-de-${String(width)}.png`),
      animations: "disabled"
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

/** Starts a chat in the project on screen and waits until its first answer is through. */
async function startChatInProject(page: Page, title: string, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: `Neuer Chat in ${title}` });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);
  await expect(page.getByText(text).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Nachricht senden" })).toBeVisible();
}

test("a project's instructions are written on its page, changed by the agent on a card, and a chat says they changed", async ({
  page,
  browser,
  baseURL
}) => {
  test.setTimeout(120_000);
  const suffix = Date.now();
  const title = `Kundenprojekt ${String(suffix)}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 }
  });
  const memberPage = await memberContext.newPage();
  await Promise.all([signIn(page, creator), signIn(memberPage, member)]);

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

  await page.goto(`/w/${workspaceId}/projects`);
  await page.getByRole("button", { name: "Neues Projekt" }).click();
  const dialog = page.getByRole("dialog", { name: "Neues Projekt" });
  await dialog.getByLabel("Name").fill(title);
  await dialog.getByRole("radio", { name: /^Geteilt mit/u }).check();
  await dialog.getByRole("button", { name: "Projekt anlegen" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const projectPath = new URL(page.url()).pathname;

  // The tile invites to write the instructions; the panel takes them.
  const tile = page.getByTestId("project-instructions-tile");
  await expect(tile).toHaveAttribute("data-state", "empty");
  await expect(tile).toContainText("Noch keine Anweisungen.");
  await shot(page, "project-instructions-tile-empty", tile);
  await tile.getByRole("button", { name: "Anweisungen schreiben" }).click();
  const panel = page.getByTestId("project-instructions-panel");
  await expect(panel).toContainText(`Jeder Chat in ${title} folgt diesen Anweisungen`);
  await page.getByTestId("project-instructions-edit").click();
  await page
    .getByTestId("project-instructions-field")
    .fill(
      "Antworte auf Deutsch.\n\nAntworte knapp, in höchstens fünf Sätzen.\n\nNenne die Quelldatei."
    );
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByTestId("project-instructions-field")).toHaveCount(0);
  await expect(panel).toContainText("Antworte knapp, in höchstens fünf Sätzen.");
  await expect(page.getByTestId("project-file-version")).toHaveCount(1);
  await shot(page, "project-instructions-panel", panel);
  await page.keyboard.press("Escape");
  await expect(tile).toHaveAttribute("data-state", "written");
  await expect(tile).toContainText(`AGENTS.md · ${creator.label}`);
  await shot(page, "project-instructions-tile", tile);

  // The member's chat in the project takes version 1 with its first answer.
  await memberPage.goto(projectPath);
  await startChatInProject(memberPage, title, "Fass bitte den Stand zusammen.");
  const memberChat = memberPage.url();
  await expect(memberPage.getByTestId("project-instructions-changed")).toHaveCount(0);

  // The creator's agent proposes a change: it waits on a card that shows it.
  await startChatInProject(page, title, "Die Antworten dürfen ausführlicher sein.");
  await page.getByPlaceholder("Nachricht").fill(
    `/tool workspace.write_file ${JSON.stringify({
      path: "project/AGENTS.md",
      content:
        "Antworte auf Deutsch.\n\nAntworte ausführlich, mit Beispielen.\n\nNenne die Quelldatei.",
      replacesVersion: 1
    })}`
  );
  await page.getByRole("button", { name: "Nachricht senden" }).click();
  const card = page.getByTestId("tool-decision-card");
  await expect(card).toContainText("Anweisungen des Projekts ändern");
  await expect(card).toContainText(`Alle in ${title} arbeiten danach.`);
  const change = card.getByTestId("project-instructions-change");
  await expect(change.locator('[data-side="before"]')).toContainText(
    "Antworte knapp, in höchstens fünf Sätzen."
  );
  await expect(change.locator('[data-side="after"]')).toContainText(
    "Antworte ausführlich, mit Beispielen."
  );
  await shot(page, "project-instructions-card", card);
  await card.getByRole("button", { name: "Erlauben", exact: true }).click();
  await expect(page.getByText(/^Tool work completed:/u)).toHaveCount(1);
  await expect(
    page.locator('[data-testid="project-file-change-line"][data-change="updated"]')
  ).toContainText("AGENTS.md aktualisiert · v2");

  // The member's chat says the instructions changed since its last answer, and shows how.
  await memberPage.goto(memberChat);
  const notice = memberPage.getByTestId("project-instructions-changed");
  await expect(notice).toContainText("Die Anweisungen des Projekts haben sich geändert.");
  await shot(memberPage, "project-instructions-changed", notice);
  await notice.getByRole("button", { name: "Änderungen anzeigen" }).click();
  const changes = memberPage.getByTestId("project-instructions-changes");
  await expect(changes).toContainText("Von Version 1 zu Version 2.");
  await expect(changes.locator('[data-side="before"]')).toContainText("Antworte knapp");
  await expect(changes.locator('[data-side="after"]')).toContainText("Antworte ausführlich");
  await shot(memberPage, "project-instructions-changes", changes);
  await memberContext.close();
});
