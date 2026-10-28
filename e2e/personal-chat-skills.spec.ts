import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// SCOPE-MYCHATS: a person switches "In meinen Chats verwenden" on a skill of their Personal
// Workspace, and the agent they chat with reads it like one of its own skills. Before the
// switch the agent is offered no `read_skill` for it; after it, the call reads the skill and
// the conversation names it among what the agent used. Fails without the change: the page has
// no switch and the run's skills hold none of the person's.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

const workspaceListSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string() }))
});
const ownSkillsSchema = z.object({
  items: z.array(z.object({ name: z.string(), inMyChats: z.boolean() }))
});

/** A name of this run's own, so a skill an earlier run left stands in no way. */
const NAME = `e2e_my_chats_${Date.now().toString(36)}`;
const TITLE = "Belegprüfung";
const skillPath = `${apiBaseUrl}/api/v1/assets/skill/${NAME}`;

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

async function ownSkill(page: Page) {
  const response = await page.request.get(`${apiBaseUrl}/api/v1/me/chat-skills`);
  expect(response.ok()).toBe(true);
  return ownSkillsSchema.parse(await response.json()).items.find((item) => item.name === NAME);
}

/** Lets the agent call a tool, and answers the message its run leaves once the run ended. */
async function callTool(page: Page, tool: string, input: unknown): Promise<Locator> {
  const messages = page.locator('[data-role="assistant"]');
  const before = await messages.count();
  const composer = page.getByPlaceholder(/^(?:Message|Nachricht)$/u);
  await composer.fill(`/tool ${tool} ${JSON.stringify(input)}`);
  const send = page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u });
  await send.click();
  await expect(messages).toHaveCount(before + 1, { timeout: 60_000 });
  await expect(send).toBeVisible({ timeout: 60_000 });
  return messages.last();
}

/** Opens the message's work history, and answers its row of the skill's read. */
async function skillRead(message: Locator): Promise<Locator> {
  const history = message.getByRole("button", { name: /^(?:Work history|Arbeitsverlauf)/u });
  if ((await history.getAttribute("aria-expanded")) !== "true") await history.click();
  await expect(history).toHaveAttribute("aria-expanded", "true");
  return message.getByRole("button", { name: `Anleitung lesen ${TITLE}` });
}

/** Pictures at phone width in both themes and at desktop width, where asked. */
async function shoot(
  page: Page,
  target: Locator,
  name: string,
  ready: () => Promise<unknown> = async () => undefined
): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  const size = page.viewportSize() ?? { width: 390, height: 844 };
  for (const [theme, width] of [
    ["light", 390],
    ["dark", 390],
    ["light", 1280]
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(
      (value) => window.localStorage.setItem("vivd-catalyst:theme", value),
      theme
    );
    await page.reload();
    await expect(target).toBeVisible();
    await ready();
    await target.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shotsDir, `my-chats-${name}-${theme}-${width}.png`),
      animations: "disabled"
    });
  }
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:theme", "light"));
  await page.setViewportSize(size);
  await page.reload();
}

test("a person's own skill switched on for their chats is read by the agent they chat with", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 300_000 : 180_000);
  await signIn(page, superadmin);
  const personalId = await personalWorkspace(page);
  const created = await requestWithOrigin(page, "put", skillPath, {
    data: {
      expectedRevision: null,
      workspaceId: personalId,
      config: {
        name: NAME,
        title: TITLE,
        description: "Use when a receipt has to be checked before it is booked.",
        content: "# Belegprüfung\n\nPrüfe Datum, Betrag und Steuersatz jedes Belegs."
      }
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate((scope) => {
      window.localStorage.setItem("vivd-catalyst:locale", "de");
      window.localStorage.setItem("vivd-catalyst:build-scope", scope);
    }, personalId);

    // Off, as every skill starts: the agent is offered nothing to read it with.
    expect(await ownSkill(page)).toEqual({ name: NAME, inMyChats: false });
    await page.goto(`/w/${personalId}`);
    const before = await callTool(page, "read_skill", { name: NAME });
    await expect(before).toContainText("Dieser Agent hat diesen Skill nicht");
    await expect(await skillRead(before)).toHaveCount(0);
    await expect(before).not.toContainText("Prüfe Datum");

    // The switch on the skill's page, under "Deine Chats".
    await page.goto(`/build/skills/${NAME}`);
    const section = page.locator("[data-skill-my-chats-section]");
    await expect(section).toBeVisible();
    const toggle = section.getByRole("switch", { name: /In meinen Chats verwenden/u });
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('[data-skill-my-chats="on"]')).toHaveCount(0);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" && response.url().includes("/me/chat-skills/")
    );
    await toggle.click();
    expect((await saved).ok()).toBe(true);
    await expect(toggle).toBeChecked();
    await expect(page.locator('[data-skill-my-chats="on"]')).toHaveText("In meinen Chats");
    expect(await ownSkill(page)).toEqual({ name: NAME, inMyChats: true });
    await shoot(page, section, "switch");

    // In a new chat the agent reads it, and the conversation names it among what it used.
    await page.goto(`/w/${personalId}`);
    const used = await callTool(page, "read_skill", { name: NAME });
    await expect(used).toContainText("Prüfe Datum, Betrag und Steuersatz");
    await expect(await skillRead(used)).toBeVisible();
    await shoot(page, used, "chat", () => skillRead(used));

    // Switched off, it is gone from the page head and from the next chat.
    await page.goto(`/build/skills/${NAME}`);
    await section.getByRole("switch", { name: /In meinen Chats verwenden/u }).click();
    await expect(page.locator('[data-skill-my-chats="on"]')).toHaveCount(0);
    await expect.poll(async () => (await ownSkill(page))?.inMyChats).toBe(false);
    await page.goto(`/w/${personalId}`);
    const after = await callTool(page, "read_skill", { name: NAME });
    await expect(after).toContainText("Dieser Agent hat diesen Skill nicht");
    await expect(after).not.toContainText("Prüfe Datum");
  } finally {
    const current = await page.request.get(`${skillPath}?workspaceId=${personalId}`);
    if (current.ok()) {
      const { revision } = z.object({ revision: z.number() }).parse(await current.json());
      await requestWithOrigin(page, "post", `${skillPath}/delete`, {
        data: { expectedRevision: revision, workspaceId: personalId }
      });
    }
  }
});
