import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { signIn } from "./inbox-fixtures";
import { assetBaseRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// An agent under "Nur ich", owned by the person's Personal Workspace, is chosen in their own
// chats. In a team whose new chats are private it is offered and runs, and the chat it ran in
// is marked personal, so a later move to the team is refused. In a team whose chats the members
// read, the picker shows it greyed with the reason. Its publish dialog says "In deinen eigenen
// Chats". Fails where the picker lists the agent only in the Personal Workspace, where it runs in
// a chat others read, or where the marked chat can still be moved.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

const workspaceListSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string() }))
});
const idSchema = z.object({ id: z.string() });

const TAG = Date.now().toString(36);
const NAME = `own_tax_${TAG}`;
const DISPLAY = `Meine Steuer ${TAG}`;
const agentPath = `${apiBaseUrl}/api/v1/assets/agent/${NAME}`;
const REASON = "Nur in deinen eigenen Chats: Diesen Chat lesen auch andere.";

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

/** A team of the person alone, whose new chats are `visibility`. */
async function team(page: Page, name: string, visibility: "private" | "workspace") {
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name, defaultConversationVisibility: visibility }
  });
  expect(created.ok(), await created.text()).toBe(true);
  return idSchema.parse(await created.json()).id;
}

/** The agent of the Personal Workspace; a later put writes its draft. */
async function putAgent(page: Page, workspaceId: string, instructions: string, draft: boolean) {
  const stored = await requestWithOrigin(page, "put", agentPath, {
    data: {
      expectedRevision: await assetBaseRevision(page, `${agentPath}?workspaceId=${workspaceId}`),
      ...(draft ? { expectedDraftRevision: null } : {}),
      workspaceId,
      config: {
        name: NAME,
        displayName: DISPLAY,
        description: "Sortiert meine Belege für die Steuer.",
        instructions
      }
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
}

const startPageAgent = (page: Page) =>
  page.getByRole("region", { name: "Chat" }).getByRole("button", { name: /^Agent auswählen/u });

const ownOption = (page: Page) => page.getByRole("option", { name: new RegExp(DISPLAY, "u") });

/** One picture at phone and one at desktop width, where `E2E_SHOTS_DIR` names a folder. */
async function shoot(page: Page, name: string, ready: () => Promise<unknown>): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const size of [PHONE, DESKTOP]) {
    await page.setViewportSize(size);
    await ready();
    await page.screenshot({
      path: join(shotsDir, `personal-agents-${name}-${size.width}.png`),
      animations: "disabled"
    });
  }
  await page.setViewportSize(PHONE);
}

/** Opens the picker of the start page, where it is closed. */
async function openPicker(page: Page): Promise<Locator> {
  const option = ownOption(page);
  if (!(await option.isVisible())) await startPageAgent(page).click();
  await expect(option).toBeVisible();
  return option;
}

test("a person's own agent is chosen in their own chats and greyed where others read", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 240_000 : 150_000);
  await signIn(page, superadmin);
  await page.setViewportSize(PHONE);
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  const personalId = await personalWorkspace(page);
  const privateTeam = await team(page, `Private Runde ${TAG}`, "private");
  const sharedTeam = await team(page, `Offene Runde ${TAG}`, "workspace");
  await putAgent(page, personalId, "Antworte knapp.", false);

  // A team chat others read: the agent is listed greyed, with the reason, and cannot be chosen.
  await page.goto(`/w/${sharedTeam}`);
  await startPageAgent(page).click();
  const greyed = ownOption(page);
  await expect(greyed).toHaveAttribute("aria-disabled", "true");
  await expect(greyed).toContainText(REASON);
  await shoot(page, "team-chat-greyed", () => openPicker(page));
  await greyed.click({ force: true });
  await expect(startPageAgent(page)).not.toHaveAccessibleName(`Agent auswählen: ${DISPLAY}`);

  // A new chat of a team whose chats are private: the agent is offered and answers.
  await page.goto(`/w/${privateTeam}`);
  await startPageAgent(page).click();
  const offered = ownOption(page);
  await expect(offered).not.toHaveAttribute("aria-disabled", "true");
  await shoot(page, "private-chat-offered", () => openPicker(page));
  await offered.click();
  await expect(startPageAgent(page)).toHaveAccessibleName(`Agent auswählen: ${DISPLAY}`);
  const run = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/conversations/runs"
  );
  const text = `Belege sortieren ${TAG}`;
  const composer = page.getByPlaceholder("Nachricht", { exact: true });
  await composer.fill(text);
  await composer.press("Enter");
  expect((await run).postDataJSON()).toMatchObject({ agentName: NAME });
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(text, {
    timeout: 60_000
  });
  await expect(page).toHaveURL(new RegExp(`/w/${privateTeam}/c/[^/]+$`, "u"));
  const conversationId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect(
    page.locator("header").getByRole("button", { name: `Agent auswählen: ${DISPLAY}` })
  ).toBeVisible();

  // Marked personal by the run: the chat never moves to the team.
  const moved = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/conversations/${conversationId}/move`,
    { data: { collaborationWorkspaceId: privateTeam, visibility: "workspace" } }
  );
  expect(moved.status(), await moved.text()).toBe(422);

  // The publish dialog says where it is chosen: in its owner's own chats.
  await putAgent(page, personalId, "Antworte knapp und nenne den Beleg.", true);
  await page.evaluate((scope) => {
    window.localStorage.setItem("vivd-catalyst:build-scope", scope);
  }, personalId);
  await page.goto(`/build/agents/${NAME}`);
  await expect(page.getByRole("heading", { name: DISPLAY })).toBeVisible();
  await page.locator("[data-agent-publish]").click();
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  const where = dialog.getByRole("radiogroup", { name: "Wählbar in:" });
  await expect(where.getByRole("radio", { name: /In deinen eigenen Chats/u })).toBeChecked();
  await expect(where).toContainText("die sonst niemand liest");
  await shoot(page, "publish-dialog", () => expect(where).toBeVisible());
});
