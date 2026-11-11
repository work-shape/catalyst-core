import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// CHAT-SHARE-6b: the creator of a private chat in a team shares it with a person of the instance
// who is in no team with them, and with a third person, whom an admin then deactivates. The
// reader finds the chat under "Shared with you" in their own rail, with the team's name, and in
// the palette, before typing and by its title, and opens it in place. Their rail and palette
// show nothing else of the team. The creator's panel marks the deactivated person and keeps
// Remove for them.

const creator = {
  email: "e2e-chat-share-swy-creator@example.test",
  password: "e2e-chat-share-swy-creator-password",
  label: "E2E Zz Swy Creator"
};
const reader = {
  email: "e2e-chat-share-swy-reader@example.test",
  password: "e2e-chat-share-swy-reader-password",
  label: "E2E Zz Swy Reader"
};
const paused = {
  email: "e2e-chat-share-swy-paused@example.test",
  password: "e2e-chat-share-swy-paused-password",
  label: "E2E Zz Swy Paused"
};
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const idSchema = z.object({ id: z.string() });
const shotsDir = process.env.E2E_SHOTS_DIR;

const TITLE =
  "a person outside the team finds the shared chat under Shared with you and in the palette";

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "left-chat",
        reason:
          "Chromium's own log line: the reader leaves the chat, the page reads its thread once " +
          "more as the chat changed, the instance answers 404 for a chat they no longer read, " +
          "and the page goes to a new chat, which the test asserts.",
        matches: requestAnswered(404),
        path: /^\/api\/v1\/conversations\/[^/]+\/thread$/u,
        tests: [TITLE]
      }
    ]
  }
});

/** Signs the page's context in through the API and answers the person's id. */
async function signInApi(page: Page, person: { email: string; password: string }) {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  const me = await page.request.get(`${apiOrigin}/api/v1/me`);
  expect(me.ok()).toBe(true);
  return idSchema.parse(await me.json()).id;
}

async function signIn(page: Page, person: { email: string; password: string }) {
  const id = await signInApi(page, person);
  await page.addInitScript(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  return id;
}

/** Escape until no dialog stands open: a search field with text takes the first to clear itself. */
async function closeDialogs(page: Page): Promise<void> {
  for (let tries = 0; tries < 3 && (await page.getByRole("dialog").count()) > 0; tries += 1) {
    await page.keyboard.press("Escape");
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/**
 * The page at 1280 and at 390 px. At 390 the rail is a drawer: `open` opens what the shot shows
 * at each width, and it is closed again after.
 */
async function shot(
  page: Page,
  name: string,
  open?: (narrow: boolean) => Promise<void>
): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await closeDialogs(page);
    await open?.(width === 390);
    await page.screenshot({
      path: join(shotsDir, `${name}-${String(width)}.png`),
      animations: "disabled"
    });
  }
  await closeDialogs(page);
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

async function setStatus(page: Page, userId: string, status: "active" | "disabled") {
  const changed = await requestWithOrigin(
    page,
    "patch",
    `${apiOrigin}/api/v1/instance/users/${userId}`,
    { data: { status } }
  );
  expect(changed.ok(), await changed.text()).toBe(true);
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
  // The paused person's id, and the admin who deactivates them, in a context of their own.
  const adminContext = await browser.newContext({ baseURL });
  const adminPage = await adminContext.newPage();
  const [, readerId, pausedId] = await Promise.all([
    signIn(page, creator),
    signIn(readerPage, reader),
    signInApi(adminPage, paused)
  ]);
  await signInApi(adminPage, superadmin);

  try {
    // A team of the creator alone, a private chat in it with one turn, and another chat of it
    // that names nobody.
    const workspaceName = `Team ${suffix}`;
    const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
      data: { name: workspaceName, defaultConversationVisibility: "private" }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const team = idSchema.parse(await created.json()).id;
    const chatTitle = `Shared plan ${suffix}`;
    const chat = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/conversations`, {
      data: { collaborationWorkspaceId: team, title: chatTitle, visibility: "private" }
    });
    expect(chat.ok(), await chat.text()).toBe(true);
    const chatId = idSchema.parse(await chat.json()).id;
    const otherChatTitle = `Not shared ${suffix}`;
    const otherChat = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/conversations`, {
      data: { collaborationWorkspaceId: team, title: otherChatTitle, visibility: "private" }
    });
    expect(otherChat.ok(), await otherChat.text()).toBe(true);
    const chatPath = `/w/${team}/c/${chatId}`;
    await page.goto(chatPath);
    await send(page, "The plan for the quarter");

    // The creator shares it with the reader and the paused person; an admin deactivates the latter.
    for (const userId of [readerId, pausedId]) {
      const added = await requestWithOrigin(
        page,
        "post",
        `${apiOrigin}/api/v1/conversations/${chatId}/people`,
        { data: { userId } }
      );
      expect(added.ok(), await added.text()).toBe(true);
    }
    await setStatus(adminPage, pausedId, "disabled");

    // The reader's own rail: the chat under "Shared with you" with the team's name, and nothing
    // else of the team.
    await readerPage.goto("/");
    const rail = readerPage.getByRole("navigation", { name: "Main navigation" });
    const group = rail.getByTestId("rail-shared-with-you");
    await expect(group).toBeVisible();
    await expect(group).toContainText("Shared with you");
    const row = group.getByTestId("rail-shared-chat");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(chatTitle);
    await expect(row.getByTestId("rail-shared-chat-workspace")).toHaveText(workspaceName);
    await expect(row).toHaveAttribute("title", `${chatTitle}, in ${workspaceName}`);
    await expect(rail.getByTestId("conversation-row").filter({ hasText: chatTitle })).toHaveCount(
      0
    );
    await expect(rail.getByText(otherChatTitle)).toHaveCount(0);
    await shot(readerPage, "shared-with-you-rail", async (narrow) => {
      if (narrow) await readerPage.getByRole("button", { name: "Open sidebar" }).click();
      await expect(readerPage.getByTestId("rail-shared-chat").first()).toBeVisible();
    });

    // The palette: under the same heading after Recent before typing, and by its title.
    const palette = readerPage.getByRole("dialog", { name: "Search" });
    const field = palette.getByRole("combobox", { name: "Search" });
    const openPalette = async () => {
      // The keys toggle it, so an open palette is closed first: each call starts it afresh.
      if (await palette.isVisible()) {
        await readerPage.keyboard.press("Escape");
        await expect(palette).toBeHidden();
      }
      // The keys reach it at every width; at 390 the rail's Search stands in the closed drawer.
      await readerPage.keyboard.press("ControlOrMeta+k");
      await expect(palette).toBeVisible();
    };
    await openPalette();
    const sharedGroup = palette.getByRole("group", { name: "Shared with you" });
    await expect(sharedGroup.getByRole("option")).toHaveCount(1);
    await expect(sharedGroup.getByRole("option")).toContainText(chatTitle);
    await expect(sharedGroup.getByRole("option")).toContainText(workspaceName);
    await shot(readerPage, "shared-with-you-palette", async () => {
      await openPalette();
      await expect(sharedGroup.getByRole("option")).toHaveCount(1);
    });
    await openPalette();
    await field.fill(`Not shared ${suffix}`);
    await expect(palette.getByText(`No results for "Not shared ${suffix}"`)).toBeVisible();
    await field.fill(`shared PLAN ${suffix}`);
    await expect(sharedGroup.getByRole("option")).toHaveCount(1);
    await expect(palette.getByRole("option")).toHaveCount(1);
    await shot(readerPage, "shared-with-you-palette-search", async () => {
      await openPalette();
      await field.fill(`shared PLAN ${suffix}`);
      await expect(sharedGroup.getByRole("option")).toHaveCount(1);
    });
    await openPalette();
    await field.fill(`shared PLAN ${suffix}`);
    await sharedGroup.getByRole("option").click();

    // It opens in place: the rail stays on their own workspace and marks the row.
    await expect(readerPage).toHaveURL(new RegExp(`${chatPath}$`, "u"));
    await expect(
      readerPage.locator('[data-role="user"]').filter({ hasText: "The plan for the quarter" })
    ).toBeVisible();
    await expect(readerPage.getByTestId("chat-outside-workspace")).toContainText(workspaceName);
    await expect(readerPage.getByPlaceholder("Message")).toBeFocused();
    await expect(row).toHaveAttribute("aria-current", "true");
    const selector = readerPage.getByTestId("collaboration-workspace-selector-trigger");
    await expect(selector).not.toContainText(workspaceName);

    // A click on the row opens it too, from the start page.
    await readerPage.goto("/");
    await row.click();
    await expect(readerPage).toHaveURL(new RegExp(`${chatPath}$`, "u"));
    await expect(readerPage.getByPlaceholder("Message")).toBeFocused();

    // The creator's panel marks the deactivated person, with Remove.
    await page.reload();
    await page.getByTestId("chat-people").click();
    const panel = page.getByRole("dialog", { name: "Who can see this chat" });
    const pausedRow = panel.getByTestId("chat-reader").filter({ hasText: paused.label });
    await expect(pausedRow).toContainText("Deactivated");
    await expect(pausedRow).toHaveAttribute("data-deactivated", "true");
    await expect(panel.getByTestId("chat-reader").filter({ hasText: reader.label })).toContainText(
      "Can read and write"
    );
    await expect(panel.getByRole("button", { name: `Remove ${paused.label}` })).toBeVisible();
    await shot(page, "shared-with-you-deactivated", async () => {
      if (!(await panel.isVisible())) await page.getByTestId("chat-people").click();
      await expect(pausedRow).toBeVisible();
    });
    if (!(await panel.isVisible())) await page.getByTestId("chat-people").click();

    // Once the reader leaves, the group is gone from their rail.
    await readerPage.goto(chatPath);
    await readerPage.getByTestId("chat-people").click();
    const readerPanel = readerPage.getByRole("dialog", { name: "Who can see this chat" });
    await readerPanel.getByRole("button", { name: "Leave", exact: true }).click();
    await readerPage.getByRole("button", { name: "Leave chat" }).click();
    await expect(readerPage).not.toHaveURL(new RegExp(`${chatId}$`, "u"));
    await expect(readerPage.getByTestId("rail-shared-with-you")).toHaveCount(0);

    // The creator removes the deactivated person.
    await panel.getByRole("button", { name: `Remove ${paused.label}` }).click();
    await expect(panel.getByTestId("chat-reader").filter({ hasText: paused.label })).toHaveCount(0);
  } finally {
    await setStatus(adminPage, pausedId, "active");
    await adminContext.close();
    await readerContext.close();
  }
});
