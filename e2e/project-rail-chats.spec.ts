import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// PRJ-5: the project whose page or chat is open unfolds in the rail to its five newest chats,
// with "Alle Chats" to its page; "Zuletzt" lists none of them again. A member reads the shared
// project's chats there and never the owner's private project. The drawer at phone width
// unfolds alike. In German.

const owner = { email: "e2e-project-rail@example.test", password: "e2e-project-rail-password" };
const member = {
  email: "e2e-project-rail-member@example.test",
  password: "e2e-project-rail-member-password"
};
const idSchema = z.object({ id: z.string() });
const projectSchema = z.object({ id: z.string(), name: z.string() });
const startedSchema = z.object({ conversation: z.object({ id: z.string() }) });
const shotsDir = process.env.E2E_SHOTS_DIR;

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
  });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({
    path: join(shotsDir, `${name}-de-${String(page.viewportSize()?.width ?? 0)}.png`),
    animations: "disabled"
  });
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

async function startChat(
  page: Page,
  workspaceId: string,
  title: string,
  projectId?: string
): Promise<string> {
  const started = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/conversations/runs`, {
    data: {
      idempotencyKey: randomUUID(),
      conversation: {
        collaborationWorkspaceId: workspaceId,
        title,
        ...(projectId ? { projectId } : {})
      },
      message: { text: `${title}?` }
    }
  });
  expect(started.ok(), await started.text()).toBe(true);
  return startedSchema.parse(await started.json()).conversation.id;
}

/** The titles of the conversation rows within a part of the rail. */
async function rowTitles(scope: Locator): Promise<string[]> {
  return (await scope.getByTestId("conversation-row").allInnerTexts()).map((text) => text.trim());
}

/** The rows of "Zuletzt": the rail's rows that do not stand under a project. */
function recentRows(page: Page): Locator {
  return page
    .getByRole("navigation", { name: "Hauptnavigation" })
    .getByRole("group", { name: "Zuletzt" })
    .getByTestId("conversation-row");
}

test("a project's chats in the rail: the open project unfolds, Zuletzt leaves its chats out", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(90_000);
  // Its own per run: runs side by side share the two people. Digits, which the title of a chat
  // keeps as they are.
  const suffix = String(Date.now()).slice(-7);
  const workspace = `Objekte ${suffix}`;
  const sharedTitle = `Hoheluft ${suffix}`;
  const privateTitle = `Notizen ${suffix}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await Promise.all([signIn(page, owner), signIn(memberPage, member)]);

  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: workspace, defaultConversationVisibility: "workspace" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const added = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/workspaces/${workspaceId}/members`,
    { data: { email: member.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);
  const shared = await createProject(page, workspaceId, sharedTitle, "workspace");
  const privateProject = await createProject(page, workspaceId, privateTitle, "private");
  await startChat(page, workspaceId, `Ohne Projekt ${suffix}`);
  const sharedTitles = [
    "Grundbuch",
    "Kaufpreis",
    "Exposé",
    "Bauzeit",
    "Finanzierung",
    "Notar",
    "Übergabe"
  ].map((topic) => `${topic} ${suffix}`);
  const sharedIds: string[] = [];
  for (const title of sharedTitles) {
    sharedIds.push(await startChat(page, workspaceId, title, shared.id));
  }
  const privateChatTitle = `Eigene Notiz ${suffix}`;
  await startChat(page, workspaceId, privateChatTitle, privateProject.id);

  // The project page open: its row unfolds to its five newest chats and "Alle Chats".
  await page.goto(`/w/${workspaceId}/p/${shared.name}`);
  const rail = page.getByRole("navigation", { name: "Hauptnavigation" });
  const unfolded = rail.getByTestId("rail-project-chats");
  await expect(unfolded).toHaveCount(1);
  await expect(unfolded).toHaveAttribute("aria-label", `Chats in ${sharedTitle}`);
  await expect(unfolded.getByTestId("conversation-row")).toHaveCount(5);
  await expect(unfolded.getByTestId("rail-project-chats-all")).toHaveText("Alle Chats");
  // Zuletzt keeps the project's older chats and the rest, and none of the five again.
  await expect(recentRows(page).filter({ hasText: `Ohne Projekt ${suffix}` })).toHaveCount(1);
  const underProject = await rowTitles(unfolded);
  const recent = (await recentRows(page).allInnerTexts()).map((text) => text.trim());
  expect(underProject.filter((title) => recent.includes(title))).toEqual([]);
  expect(
    sharedTitles.filter((title) => !underProject.includes(title) && !recent.includes(title))
  ).toEqual([]);
  await shot(page, "rail-project-page");

  // A chat opened from under the row: the project stays unfolded and the chat is the current row.
  const opened = underProject[1] ?? "";
  await unfolded
    .getByTestId("conversation-row")
    .filter({ hasText: opened })
    .getByRole("button")
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/c/`, "u"));
  await expect(
    unfolded.locator('[data-testid="conversation-row"][data-selected="true"]')
  ).toHaveText(opened);
  await expect(recentRows(page).filter({ hasText: opened })).toHaveCount(0);
  await shot(page, "rail-project-chat");

  // "Alle Chats" leads to the project's page.
  await unfolded.getByTestId("rail-project-chats-all").click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/p/${shared.name}$`, "u"));

  // The private project unfolds to its creator's chat alone.
  await rail.getByTestId("rail-project").filter({ hasText: privateTitle }).click();
  await expect(unfolded.getByTestId("conversation-row")).toHaveCount(1);
  await expect(unfolded.getByTestId("conversation-row")).toHaveText(privateChatTitle);

  // The member, in a chat of the shared project, reads its chats there; the private one is none.
  await memberPage.goto(`/w/${workspaceId}/c/${sharedIds[0] ?? ""}`);
  const memberRail = memberPage.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(memberRail.getByTestId("rail-project")).toHaveCount(1);
  const memberUnfolded = memberRail.getByTestId("rail-project-chats");
  // The open chat stands among them, after the five newest when it is older.
  await expect(
    memberUnfolded.locator('[data-testid="conversation-row"][data-selected="true"]')
  ).toHaveText(sharedTitles[0] ?? "");
  expect(await memberUnfolded.getByTestId("conversation-row").count()).toBeGreaterThanOrEqual(5);
  await expect(memberPage.getByText(privateChatTitle)).toHaveCount(0);
  await expect(memberPage.getByText(privateTitle)).toHaveCount(0);
  await memberContext.close();

  // At phone width the drawer unfolds the open project alike, and a chat opened there closes it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/w/${workspaceId}/c/${sharedIds[6] ?? ""}`);
  await page.getByRole("button", { name: "Seitenleiste öffnen" }).click();
  await expect(
    unfolded.locator('[data-testid="conversation-row"][data-selected="true"]')
  ).toHaveText(sharedTitles[6] ?? "");
  expect(await unfolded.getByTestId("conversation-row").count()).toBeGreaterThanOrEqual(5);
  await shot(page, "rail-project-drawer");
  const next = (await rowTitles(unfolded)).find((title) => title !== sharedTitles[6]) ?? "";
  await unfolded
    .getByTestId("conversation-row")
    .filter({ hasText: next })
    .getByRole("button")
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/c/[^/]+$`, "u"));
  await expect(page).not.toHaveURL(new RegExp(`/c/${sharedIds[6] ?? ""}$`, "u"));
  await expect(unfolded).toBeHidden();
  await expect(page.getByRole("button", { name: "Seitenleiste öffnen" })).toBeVisible();
});
