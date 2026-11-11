import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// CHAT-SHARE-6a: the creator of a private chat in a team shares it with a person of the instance
// who is in no team with them. One letter after @ searches only the people offered; from two
// letters the instance is searched, and the person shows "not in" the team. Both confirm lines
// stand above the composer, and Send shares and sends. The person opens the chat from the Inbox
// without the team in their selector, reads it and sends a turn an agent of the instance
// answers. The team's chat list, by its link, is not there for them.

const creator = {
  email: "e2e-chat-share-outside@example.test",
  password: "e2e-chat-share-outside-password",
  label: "E2E Zz Outside Creator"
};
const reader = {
  email: "e2e-chat-share-qxana@example.test",
  password: "e2e-chat-share-qxana-password",
  label: "E2E Zz Qxana Outside"
};
const idSchema = z.object({ id: z.string() });
const shotsDir = process.env.E2E_SHOTS_DIR;

const TITLE =
  "a person outside the team finds the shared chat in the Inbox, reads it and answers in place";

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "team-not-there",
        reason:
          "Chromium's own log line: the reader follows a link to the team's chat list, the " +
          "page asks for its chats, its agents and the team itself before it knows the link is " +
          "closed, the instance answers 404 for a team they are no member of, and the page goes " +
          "to their own workspace, which the test asserts.",
        matches: requestAnswered(404),
        path: /^\/api\/v1\/(?:conversations|workspaces\/[^/]+(?:\/agents)?)$/u,
        tests: [TITLE]
      }
    ]
  }
});

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

/** The page at 1280 and 390. */
async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.screenshot({
      path: join(shotsDir, `${name}-${String(width)}.png`),
      animations: "disabled"
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

/** Sends a message in the open chat and waits for its answer to end. */
async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder("Message");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.locator('[data-role="user"]').filter({ hasText: text })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Stop/u })).toHaveCount(0, { timeout: 30_000 });
}

test(TITLE, async ({ page, browser, baseURL, pageErrors }) => {
  test.setTimeout(150_000);
  const suffix = String(Date.now());
  await page.setViewportSize({ width: 1280, height: 800 });
  const readerContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 }
  });
  await pageErrors.watch(readerContext);
  const readerPage = await readerContext.newPage();
  await Promise.all([signIn(page, creator), signIn(readerPage, reader)]);

  // A team of the creator alone, and a private chat in it with one turn.
  const workspaceName = `Team ${suffix}`;
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: workspaceName, defaultConversationVisibility: "private" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const team = idSchema.parse(await created.json()).id;
  const chatTitle = `Outside plan ${suffix}`;
  const chat = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/conversations`, {
    data: { collaborationWorkspaceId: team, title: chatTitle, visibility: "private" }
  });
  expect(chat.ok(), await chat.text()).toBe(true);
  const chatId = idSchema.parse(await chat.json()).id;
  const chatPath = `/w/${team}/c/${chatId}`;
  await page.goto(chatPath);
  await send(page, "The plan for the quarter");

  // One letter searches only the people offered, and nobody is offered yet.
  const composer = page.getByPlaceholder("Message");
  await composer.click();
  await composer.pressSequentially("@q");
  await expect(
    page.getByRole("status").filter({ hasText: "Type one more letter to search everyone." })
  ).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(0);

  // From two letters the instance is searched: the person is offered, marked as not in the team.
  await composer.pressSequentially("x");
  const menu = page.getByRole("listbox", { name: "People to share this chat with" });
  const option = menu.getByRole("option", { name: new RegExp(reader.label, "u") });
  await expect(option).toBeVisible();
  await expect(option).toContainText(`not in ${workspaceName}`);
  await shot(page, "chat-share-outside-menu");
  await composer.press("Enter");
  await expect(page.getByTestId("share-chips")).toContainText(reader.label);
  await expect(page.getByTestId("share-confirm-line")).toHaveText(
    `${reader.label} will see the whole chat, files included, and can write in it.`
  );
  await expect(page.getByTestId("share-outside-line")).toHaveText(
    `${reader.label} is not in ${workspaceName}: they see only this chat, and their turns run ` +
      "with their own rights."
  );
  await composer.pressSequentially("please read along");
  await shot(page, "chat-share-outside-chips");
  await composer.press("Enter");
  await expect(page.getByTestId("share-chips")).toHaveCount(0);
  await expect(
    page.locator('[data-role="user"]').filter({ hasText: "please read along" })
  ).toBeVisible();
  await expect(page.getByTestId("chat-people")).toHaveAttribute(
    "aria-label",
    `Who can see this chat: ${reader.label}`
  );
  await expect(page.getByRole("button", { name: /^Stop/u })).toHaveCount(0, { timeout: 30_000 });

  // The reader opens the chat from the Inbox, in place: the rail stays on their own workspace.
  await readerPage.goto("/inbox");
  const inbox = readerPage.getByRole("region", { name: "Inbox", exact: true });
  const row = inbox.getByTestId("inbox-row").filter({ hasText: chatTitle });
  await expect(row).toHaveCount(1);
  await row.getByRole("button").click();
  await readerPage.getByRole("link", { name: "Open chat" }).click();
  await expect(readerPage).toHaveURL(new RegExp(`${chatPath}$`, "u"));
  await expect(
    readerPage.locator('[data-role="user"]').filter({ hasText: "The plan for the quarter" })
  ).toBeVisible();
  await expect(readerPage.getByTestId("chat-outside-workspace")).toContainText(workspaceName);
  await expect(readerPage.getByTestId("chat-share-button")).toHaveCount(0);
  const selector = readerPage.getByTestId("collaboration-workspace-selector-trigger");
  await expect(selector).toBeVisible();
  await expect(selector).not.toContainText(workspaceName);
  await expect(readerPage.getByTestId("conversation-shared-marker")).toHaveCount(0);
  await shot(readerPage, "chat-share-outside-reader");

  // Their turn is answered by an agent of the instance, and the creator reads it.
  await send(readerPage, "Read it, the plan holds.");
  await expect(readerPage.getByTestId("message-sender").last()).toHaveText("You");
  await page.reload();
  await expect(
    page.locator('[data-role="user"]').filter({ hasText: "Read it, the plan holds." })
  ).toBeVisible();
  await expect(page.getByTestId("message-sender").last()).toHaveText(reader.label);

  // The panel offers the reader Leave, and nothing to add anyone.
  await readerPage.getByTestId("chat-people").click();
  const panel = readerPage.getByRole("dialog", { name: "Who can see this chat" });
  await expect(panel.getByTestId("chat-reader")).toHaveCount(2);
  await expect(panel.getByRole("button", { name: "Leave", exact: true })).toBeVisible();
  await expect(panel.getByLabel("Add person")).toHaveCount(0);
  await panel.getByRole("button", { name: "Close" }).first().click();

  // Nothing else of the team is there for them: its chat list, by its link or its operation.
  const list = await readerPage.request.get(
    `${apiOrigin}/api/v1/conversations?collaborationWorkspaceId=${team}`
  );
  expect(list.status()).toBe(404);
  const workspace = await readerPage.request.get(`${apiOrigin}/api/v1/workspaces/${team}`);
  expect(workspace.status()).toBe(404);
  await readerPage.goto(`/w/${team}`);
  await expect(readerPage).not.toHaveURL(new RegExp(`/w/${team}`, "u"));
  await expect(readerPage.getByText(chatTitle)).toHaveCount(0);

  await readerContext.close();
});
