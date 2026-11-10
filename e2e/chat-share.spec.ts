import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// CHAT-SHARE-2: the creator of a private chat in a team shares it with one member from the
// composer's @. The member opens it from the Inbox and answers; another member of the team
// cannot open it by its link. The member leaves, the creator adds them again in the panel and
// removes them. A chat marked personal is refused in the @ menu.

const creator = { email: "e2e-chat-share@example.test", password: "e2e-chat-share-password" };
const reader = {
  email: "e2e-chat-share-reader@example.test",
  password: "e2e-chat-share-reader-password",
  label: "E2E Zz Chat Share Reader"
};
const outsider = {
  email: "e2e-chat-share-outsider@example.test",
  password: "e2e-chat-share-outsider-password"
};
const idSchema = z.object({ id: z.string() });
const shotsDir = process.env.E2E_SHOTS_DIR;
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;

const TITLE = "the creator shares a private chat with a member, who answers, leaves and is removed";

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "chat-not-shared",
        reason:
          "Chromium's own log line: a member the chat was not shared with opens its link, the " +
          "instance answers 404 and the page says the chat is not there, which the test asserts.",
        matches: requestAnswered(404),
        path: /^\/api\/v1\/conversations\/[^/]+(?:\/[a-z-]+)?$/u,
        tests: [TITLE]
      },
      {
        name: "chat-marked-personal",
        reason:
          "Chromium's own log line: the @ menu asks whom to offer for a chat marked personal, " +
          "the instance refuses it with 422 and the menu says why, which the test asserts.",
        matches: requestAnswered(422),
        path: /^\/api\/v1\/conversations\/[^/]+\/share-candidates$/u,
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

async function privateChat(page: Page, workspaceId: string, title: string): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/conversations`, {
    data: { collaborationWorkspaceId: workspaceId, title, visibility: "private" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  return idSchema.parse(await created.json()).id;
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
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } }))
  );
  const [readerContext, outsiderContext] = contexts;
  if (!readerContext || !outsiderContext) throw new Error("No browser context");
  await Promise.all(contexts.map((context) => pageErrors.watch(context)));
  const readerPage = await readerContext.newPage();
  const outsiderPage = await outsiderContext.newPage();
  await Promise.all([
    signIn(page, creator),
    signIn(readerPage, reader),
    signIn(outsiderPage, outsider)
  ]);

  // A team of three; the reader has written in one of its team chats, so the creator knows them.
  const workspaceName = `Team ${suffix}`;
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: workspaceName, defaultConversationVisibility: "workspace" }
  });
  expect(created.ok()).toBe(true);
  const team = idSchema.parse(await created.json()).id;
  for (const person of [reader, outsider]) {
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/workspaces/${team}/members`,
      { data: { email: person.email } }
    );
    expect(added.ok(), await added.text()).toBe(true);
  }
  await readerPage.goto(`/w/${team}`);
  await send(readerPage, "Hello team");

  // The creator's private chat: a bare @ offers the reader.
  const chatTitle = `Quarter plan ${suffix}`;
  const chatId = await privateChat(page, team, chatTitle);
  const chatPath = `/w/${team}/c/${chatId}`;
  await page.goto(chatPath);
  const composer = page.getByPlaceholder("Message");
  await composer.click();
  await composer.pressSequentially("Please check @");
  const menu = page.getByRole("listbox", { name: "People to share this chat with" });
  const option = menu.getByRole("option", { name: new RegExp(reader.label, "u") });
  await expect(option).toBeVisible();
  await shot(page, "chat-share-menu");

  // Letters search the people offered; Enter picks one, who becomes a chip.
  await composer.pressSequentially("E2E Zz Chat Share R");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await composer.press("Enter");
  await expect(menu).toBeHidden();
  await expect(page.getByTestId("share-chips")).toContainText(reader.label);
  await expect(page.getByTestId("share-confirm-line")).toHaveText(
    `${reader.label} will see the whole chat, files included, and can write in it.`
  );
  await composer.pressSequentially("the numbers");
  await shot(page, "chat-share-chips");

  // Send shares first, then sends: the head shows who reads the chat.
  await composer.press("Enter");
  await expect(page.getByTestId("share-chips")).toHaveCount(0);
  await expect(page.locator('[data-role="user"]').filter({ hasText: "the numbers" })).toBeVisible();
  await expect(page.getByTestId("chat-people")).toHaveAttribute(
    "aria-label",
    `Who can see this chat: ${reader.label}`
  );
  await expect(page.getByRole("button", { name: /^Stop/u })).toHaveCount(0, { timeout: 30_000 });

  // The reader's Inbox notice opens the chat, where they answer.
  await readerPage.goto("/inbox");
  const inbox = readerPage.getByRole("region", { name: "Inbox", exact: true });
  const row = inbox.getByTestId("inbox-row").filter({ hasText: chatTitle });
  await expect(row).toHaveCount(1);
  await row.getByRole("button").click();
  await readerPage.getByRole("link", { name: "Open chat" }).click();
  await expect(readerPage).toHaveURL(new RegExp(`${chatPath}$`, "u"));
  await expect(
    readerPage.locator('[data-role="user"]').filter({ hasText: "the numbers" })
  ).toBeVisible();
  await send(readerPage, "The numbers look right.");
  await expect(readerPage.getByTestId("message-sender").last()).toHaveText("You");
  await page.reload();
  await expect(
    page.locator('[data-role="user"]').filter({ hasText: "The numbers look right." })
  ).toBeVisible();
  await expect(page.getByTestId("message-sender").last()).toHaveText(reader.label);
  // Every reader sees the people mark in the rail.
  await expect(page.getByTestId("conversation-shared-marker").first()).toHaveAttribute(
    "aria-label",
    `Shared with ${reader.label}`
  );

  // Another member of the team cannot open it by its link.
  const notShared = await outsiderPage.request.get(`${apiOrigin}/api/v1/conversations/${chatId}`);
  expect(notShared.status()).toBe(404);
  await outsiderPage.goto(chatPath);
  await expect(outsiderPage.getByText("the numbers")).toHaveCount(0);
  await expect(outsiderPage.getByText("The numbers look right.")).toHaveCount(0);

  // The reader leaves the chat from the panel.
  await readerPage.getByTestId("chat-people").click();
  const readerPanel = readerPage.getByRole("dialog", { name: "Who can see this chat" });
  await expect(readerPanel.getByTestId("chat-reader")).toHaveCount(2);
  await readerPanel.getByRole("button", { name: "Leave", exact: true }).click();
  await readerPage
    .getByRole("dialog", { name: "Leave this chat?" })
    .getByRole("button", { name: "Leave chat" })
    .click();
  await expect(readerPage).not.toHaveURL(new RegExp(`${chatId}$`, "u"));
  const gone = await readerPage.request.get(`${apiOrigin}/api/v1/conversations/${chatId}`);
  expect(gone.status()).toBe(404);

  // The creator adds them again in the panel, then removes them.
  await page.reload();
  await page.getByRole("button", { name: "Share this chat" }).click();
  const panel = page.getByRole("dialog", { name: "Who can see this chat" });
  await panel.getByLabel("Add person").fill("E2E Zz Chat Share R");
  await panel.getByRole("option", { name: new RegExp(reader.label, "u") }).click();
  await expect(panel.getByTestId("chat-reader")).toHaveCount(2);
  await shot(page, "chat-share-people");
  await panel.getByRole("button", { name: `Remove ${reader.label}` }).click();
  await expect(panel.getByTestId("chat-reader")).toHaveCount(1);
  await expect(panel).toContainText("Only you see this chat.");
  const removed = await readerPage.request.get(`${apiOrigin}/api/v1/conversations/${chatId}`);
  expect(removed.status()).toBe(404);
  await panel.getByRole("button", { name: "Close" }).first().click();

  // A chat marked personal is refused in the @ menu, and nothing is offered.
  const markedId = await privateChat(page, team, `Personal ${suffix}`);
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`update conversations set personal_data_at = now() where id = ${markedId}`;
  } finally {
    await sql.end();
  }
  await page.goto(`/w/${team}/c/${markedId}`);
  await composer.click();
  await composer.pressSequentially("@");
  await expect(
    page.getByRole("status").filter({ hasText: /^This chat used something only you can use/u })
  ).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(0);
  await shot(page, "chat-share-refusal");

  await Promise.all(contexts.map((context) => context.close()));
});
