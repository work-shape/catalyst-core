import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const member = { email: "e2e-user@example.test", password: "e2e-user-password" };
/** May decide skill changes, so the rail shows this person the Inbox row. */
const reviewer = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

/** As many conversations as the rail asks for at once (`RAIL_PAGE_SIZE`). */
const railPageSize = 30;
/** How often the rail reads its conversations again while it must (`RAIL_REFRESH_INTERVAL_MS`). */
const railRefreshIntervalMs = 2_000;
/**
 * The fixture model echoes a message one word every 20 ms, so this many words are a run of
 * about ten seconds.
 */
const longRunWords = 500;

const rail = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });

// Fails with the Chat row: the rail then held a "Chat" button above the Inbox, and it was the
// current item in a conversation instead of the conversation's own row.
test("the rail has no Chat entry, and New chat starts a conversation whose row is the current one", async ({
  page
}) => {
  await signIn(page, reviewer);
  const navigation = rail(page);

  await expect(navigation.getByRole("button", { name: /^Inbox/u })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "New chat", exact: true })).toHaveCount(1);

  // From another area New chat leads to the start page, with the cursor in the composer.
  await navigation.getByRole("button", { name: /^Inbox/u }).click();
  await expect(page).toHaveURL(/\/inbox$/u);
  await navigation.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  const composer = page.getByPlaceholder("Message");
  await expect(composer).toBeFocused();
  // Nothing in the rail claims the start page.
  await expect(navigation.locator("[aria-current]")).toHaveCount(0);

  const text = `One entry for a chat ${Date.now()}`;
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/w\/[^/]+\/c\/[^/]+$/u);
  const current = navigation.locator('[aria-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(
    navigation
      .getByTestId("conversation-row")
      .filter({ has: page.locator('[aria-current="true"]') })
  ).toHaveCount(1);
  await expect(navigation.getByTestId("conversation-row").first()).toHaveAttribute(
    "data-selected",
    "true"
  );
});

// Fails with the list page and the one-page rail: the rail then ended in "Show all", which
// opened a page of its own, and never held more than its first 30 conversations.
test("the rail is the list of conversations: it loads a page at a time, the search finds what no loaded page holds, and an older open conversation is the first row", async ({
  page
}) => {
  test.setTimeout(240_000);
  await signIn(page, member);
  const stamp = Date.now();
  const workspace = await createWorkspace(page, `Rail pages ${stamp}`);
  const workspacePath = `/w/${encodeURIComponent(workspace.id)}`;
  const navigation = rail(page);
  const railRows = navigation.getByTestId("conversation-row");
  const loadMore = navigation.getByRole("button", { name: "Load more", exact: true });
  const firstPage = { collaborationWorkspaceId: workspace.id, limit: String(railPageSize) };

  // The two oldest conversations: one the search has to find, one opened by its address.
  const oldestTitle = `Mietvertrag Altbau ${stamp}`;
  const oldest = await createListedConversation(page, workspace.id, oldestTitle);
  const olderTitle = `Kaufvertrag Neubau ${stamp}`;
  const older = await createListedConversation(page, workspace.id, olderTitle);
  await createListedConversations(page, workspace.id, railPageSize - 2, `Filler ${stamp} a`);

  // With exactly one page of conversations the rail shows them all and offers nothing more.
  await page.goto(workspacePath);
  await expect(railRows).toHaveCount(railPageSize);
  await expect(railRows.filter({ hasText: oldestTitle })).toHaveCount(1);
  await expect(loadMore).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Show all", exact: true })).toHaveCount(0);

  // Two full pages and a few rows of a third.
  const total = 2 * railPageSize + 5;
  await createListedConversations(page, workspace.id, total - railPageSize, `Filler ${stamp} b`);
  const railReads = railListRequests(page);
  await page.reload();
  await expect(railRows).toHaveCount(railPageSize);
  await expect(railRows.filter({ hasText: oldestTitle })).toHaveCount(0);
  // The quiet row ends the list, below what the window shows, and nothing is loaded for it.
  await expect(
    navigation.getByRole("group", { name: "Recent" }).getByRole("button").last()
  ).toHaveText("Load more");
  await expect(loadMore).not.toBeInViewport();
  expect(railReads()).toEqual([{ ...firstPage, cursor: null }]);

  // The search in the rail's header asks the server, so it finds a conversation that no
  // loaded page holds. Opened, it is the first row and the current one.
  await navigation.getByRole("button", { name: "Search", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Search" });
  await palette.getByRole("combobox", { name: "Search" }).fill(`mietvertrag altbau ${stamp}`);
  await palette.getByRole("option", { name: oldestTitle }).click();
  await expect(page).toHaveURL(
    new RegExp(`${workspacePath}/c/${encodeURIComponent(oldest.id)}$`, "u")
  );
  await expect(page.getByText(`Opening message for ${oldestTitle}`, { exact: true })).toBeVisible();
  await expect(railRows).toHaveCount(railPageSize + 1);
  await expect(railRows.first()).toContainText(oldestTitle);
  await expect(railRows.first()).toHaveAttribute("data-selected", "true");
  await expect(navigation.locator('[aria-current="true"]')).toHaveCount(1);
  // Opening it read its thread and no list.
  expect(railReads()).toHaveLength(1);

  // The row renames and deletes like every other row of the rail.
  await railRows
    .first()
    .getByRole("button", { name: `Conversation options for ${oldestTitle}` })
    .click();
  await page.getByRole("menuitem", { name: "Rename conversation", exact: true }).click();
  const railTitle = page.getByRole("textbox", { name: "Conversation title", exact: true });
  await expect(railTitle).toHaveValue(oldestTitle);
  const renamedTitle = `Mietvertrag umbenannt ${stamp}`;
  await railTitle.fill(renamedTitle);
  await railTitle.press("Enter");
  const renamedRow = railRows.filter({ hasText: renamedTitle });
  await expect(renamedRow).toHaveCount(1);
  await expect(renamedRow).toHaveAttribute("data-selected", "true");
  await expect(railRows.filter({ hasText: oldestTitle })).toHaveCount(0);

  const deleteFromRail = page.getByRole("menuitem", { name: "Delete conversation", exact: true });
  await expect(async () => {
    if (!(await deleteFromRail.isVisible())) {
      await renamedRow
        .getByRole("button", { name: `Conversation options for ${renamedTitle}` })
        .click({ timeout: 2_000 });
    }
    await deleteFromRail.click({ timeout: 1_000 });
  }).toPass();
  await page
    .getByRole("dialog", { name: "Delete conversation?", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  // The latest conversation opens in its place.
  await expect(renamedRow).toHaveCount(0);
  await expect(railRows).toHaveCount(railPageSize);
  await expect(railRows.first()).toHaveAttribute("data-selected", "true");
  await expect(page).not.toHaveURL(new RegExp(encodeURIComponent(oldest.id), "u"));

  // An older conversation opened by its address is the first row, from the thread on screen,
  // and the rail has asked for its one page.
  const readsBeforeAddress = railReads().length;
  await page.goto(`${workspacePath}/c/${encodeURIComponent(older.id)}`);
  await expect(railRows).toHaveCount(railPageSize + 1);
  await expect(railRows.first()).toContainText(olderTitle);
  await expect(railRows.first()).toHaveAttribute("data-selected", "true");
  expect(railReads().slice(readsBeforeAddress)).toEqual([{ ...firstPage, cursor: null }]);

  // Scrolling to the end of the rows loads the next page: one request, from where the first
  // page ended.
  await loadMore.scrollIntoViewIfNeeded();
  await expect(railRows).toHaveCount(2 * railPageSize + 1);
  expect(railReads()).toHaveLength(readsBeforeAddress + 2);
  expect(railReads().at(-1)?.limit).toBe(String(railPageSize));
  expect(railReads().at(-1)?.cursor).not.toBeNull();
  await expect(loadMore).not.toBeInViewport();

  // A page that fails to load says so and keeps the rows. The keyboard reaches the row that
  // loads it and the one that tries again.
  let failing = true;
  await page.route(
    (url) => url.pathname === "/api/v1/conversations" && url.searchParams.has("cursor"),
    async (route) => {
      if (failing) {
        await route.fulfill({
          status: 503,
          json: { error: { code: "INTERNAL", message: "down" } }
        });
      } else {
        await route.continue();
      }
    }
  );
  await loadMore.focus();
  await page.keyboard.press("Enter");
  const failed = navigation.getByRole("alert").filter({
    hasText: "More conversations could not be loaded."
  });
  await expect(failed).toBeVisible();
  await expect(railRows).toHaveCount(2 * railPageSize + 1);
  const afterFailure = railReads().length;
  // Nothing tries again by itself.
  await page.waitForTimeout(1_000);
  expect(railReads()).toHaveLength(afterFailure);
  failing = false;
  const tryAgain = failed.getByRole("button", { name: "Try again" });
  await tryAgain.focus();
  await page.keyboard.press("Enter");
  // The list is at its end. The open conversation stands in its own place, once.
  await expect(railRows).toHaveCount(total - 1);
  await expect(loadMore).toHaveCount(0);
  await expect(failed).toHaveCount(0);
  await expect(railRows.last()).toContainText(olderTitle);
  await expect(railRows.last()).toHaveAttribute("data-selected", "true");
  await expect(railRows.filter({ hasText: olderTitle })).toHaveCount(1);
  expect(railReads()).toHaveLength(afterFailure + 1);

  // Another workspace and back: the loaded pages are let go, and the first one is read again.
  const selector = page.getByTestId("collaboration-workspace-selector-trigger");
  await selector.click();
  await page.getByRole("button", { name: "Personal workspace" }).click();
  await expect(page).not.toHaveURL(new RegExp(workspacePath, "u"));
  await selector.click();
  await page.getByRole("button", { name: workspace.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${workspacePath}$`, "u"));
  await expect(railRows).toHaveCount(railPageSize);
  await expect(loadMore).toHaveCount(1);

  // The addresses of the former list page lead to the start page of the workspace.
  await page.goto(`${workspacePath}/conversations`);
  await expect(page).toHaveURL(new RegExp(`${workspacePath}$`, "u"));
  await expect(page.getByPlaceholder("Message")).toBeVisible();
  await page.goto("/conversations");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await expect(page.getByPlaceholder("Message")).toBeVisible();
});

// Fails without the change: while a run was active the rail read its whole list once a second,
// so a ten-second run in the open conversation cost about ten list requests, each of them every
// page of the list.
test("a run in the open conversation is followed by its stream, and the rail reads one page when it starts, when it ends and after a workspace switch", async ({
  page
}) => {
  test.setTimeout(120_000);
  await signIn(page, member);
  const stamp = Date.now();
  const workspace = await createWorkspace(page, `Rail requests ${stamp}`);
  const otherWorkspace = await createWorkspace(page, `Rail requests other ${stamp}`);
  const title = `Laufende Unterhaltung ${stamp}`;
  const conversation = await createListedConversation(page, workspace.id, title);
  const otherTitle = `Andere Unterhaltung ${stamp}`;
  await createListedConversation(page, otherWorkspace.id, otherTitle);
  const navigation = rail(page);
  const railRows = navigation.getByTestId("conversation-row");
  const row = railRows.filter({ hasText: title });
  const running = row.getByTestId("conversation-running-indicator");
  const railReads = railListRequests(page);
  const onePage = (collaborationWorkspaceId: string) => ({
    collaborationWorkspaceId,
    limit: String(railPageSize),
    cursor: null
  });

  await page.goto(
    `/w/${encodeURIComponent(workspace.id)}/c/${encodeURIComponent(conversation.id)}`
  );
  await expect(row).toHaveAttribute("data-selected", "true");
  expect(railReads()).toEqual([onePage(workspace.id)]);

  // A second message gets no title job, so nothing but the run changes the list.
  const composer = page.getByPlaceholder("Message");
  const stop = page.getByRole("button", { name: "Stop generating" });
  await composer.fill(
    [`run-${stamp}`, ...Array.from({ length: longRunWords - 1 }, (_, index) => `w${index}`)].join(
      " "
    )
  );
  await composer.press("Enter");
  await expect(stop).toBeVisible();
  await expect(running).toBeVisible();
  const startedAt = Date.now();
  await expect(stop).toHaveCount(0, { timeout: 30_000 });
  const ranMs = Date.now() - startedAt;
  // The row learns of the end from the stream's last event.
  await expect(running).toHaveCount(0);
  const duringRun = railReads().length - 1;
  // A run shorter than this proves nothing about a reading every interval.
  expect(ranMs).toBeGreaterThan(3 * railRefreshIntervalMs);
  // One reading when the run is accepted and one when it ends. A reading that arrived before
  // the server had recorded the end is followed by one more, an interval later.
  expect(duringRun).toBeGreaterThanOrEqual(2);
  expect(duringRun).toBeLessThanOrEqual(3);
  for (const read of railReads()) {
    expect(read).toEqual(onePage(workspace.id));
  }

  // With no run active nothing reads the list.
  const settled = railReads().length;
  await page.waitForTimeout(2 * railRefreshIntervalMs + 500);
  expect(railReads()).toHaveLength(settled);

  // Another workspace has its own rows, read with one request.
  await page.goto(`/w/${encodeURIComponent(otherWorkspace.id)}`);
  await expect(railRows).toHaveCount(1);
  await expect(railRows.first()).toContainText(otherTitle);
  expect(railReads().slice(settled)).toEqual([onePage(otherWorkspace.id)]);

  // A new chat is the first row at once. Its title is written by a job after the first
  // message, so the list is read until the title is there, and then no more.
  await composer.fill(`neue unterhaltung ${stamp}`);
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/w\/[^/]+\/c\/[^/]+$/u);
  await expect(railRows).toHaveCount(2);
  await expect(railRows.first()).toHaveAttribute("data-selected", "true");
  await expect(railRows.last()).toContainText(otherTitle);
  await expect(railRows.first()).toContainText(`Neue Unterhaltung ${stamp}`, { timeout: 30_000 });
  await expect(stop).toHaveCount(0, { timeout: 30_000 });
  await expect(railRows.first().getByTestId("conversation-running-indicator")).toHaveCount(0);
  const afterNewChat = railReads().length;
  await page.waitForTimeout(2 * railRefreshIntervalMs + 500);
  expect(railReads()).toHaveLength(afterNewChat);
  for (const read of railReads().slice(settled)) {
    expect(read).toEqual(onePage(otherWorkspace.id));
  }
});

// Fails with the list page: the strip then held a "Conversations" icon that opened it.
test("the collapsed rail keeps the search and New chat, and no entry for a list page", async ({
  page
}) => {
  await signIn(page, member);
  const navigation = rail(page);

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(navigation.getByTestId("conversation-row")).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Conversations", exact: true })).toHaveCount(
    0
  );
  const strip = navigation.getByRole("button");
  await expect(strip.nth(0)).toHaveAccessibleName("Expand sidebar");
  await expect(strip.nth(1)).toHaveAccessibleName("Search");
  await expect(strip.nth(2)).toHaveAccessibleName("New chat");

  // The search is the strip's way to a conversation.
  await strip.nth(1).click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Escape");

  await navigation.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await expect(page.getByPlaceholder("Message")).toBeFocused();
  await expect(navigation.locator("[aria-current]")).toHaveCount(0);
});

// Fails with the shield: the file then held the shield's path and no orange field.
test("the application's favicon is the Catalyst mark", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
  const served = await page.request.get("/favicon.svg");
  expect(served.ok()).toBe(true);
  const mark = await served.text();

  expect(mark).toContain('aria-label="Workshape Catalyst"');
  expect(mark).toContain('<rect class="s" width="32" height="32"/>');
  expect(mark).toContain('<rect class="b" x="18" y="18" width="12" height="12"/>');
  expect(mark).not.toContain("<path");
});

/**
 * What the rail has asked the conversation list for so far. The palette asks with a search
 * text; everything else on that path is the rail.
 */
function railListRequests(page: Page): () => {
  collaborationWorkspaceId: string | null;
  limit: string | null;
  cursor: string | null;
}[] {
  const requests: ReturnType<ReturnType<typeof railListRequests>> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() !== "GET" ||
      url.pathname !== "/api/v1/conversations" ||
      url.searchParams.has("query")
    ) {
      return;
    }
    requests.push({
      collaborationWorkspaceId: url.searchParams.get("collaborationWorkspaceId"),
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor")
    });
  });
  return () => [...requests];
}

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(rail(page).getByRole("button", { name: "Search", exact: true })).toBeVisible();
}

async function createWorkspace(page: Page, name: string): Promise<{ id: string; name: string }> {
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name }
  });
  expect(created.ok()).toBe(true);
  return z.object({ id: z.string(), name: z.string() }).parse(await created.json());
}

/** A conversation the list shows: one with a message, whose run has ended. */
async function createListedConversation(
  page: Page,
  collaborationWorkspaceId: string,
  title: string
): Promise<{ id: string }> {
  const started = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations/runs`, {
    data: {
      idempotencyKey: randomUUID(),
      conversation: { title, collaborationWorkspaceId },
      message: { text: `Opening message for ${title}` }
    }
  });
  expect(started.ok()).toBe(true);
  const { conversation } = z
    .object({ conversation: z.object({ id: z.string() }) })
    .parse(await started.json());
  await expect
    .poll(async () => {
      const thread = await page.request.get(
        `${apiBaseUrl}/api/v1/conversations/${encodeURIComponent(conversation.id)}/thread`
      );
      expect(thread.ok()).toBe(true);
      const snapshot = z
        .object({ activeRun: z.unknown().optional(), messages: z.array(z.unknown()) })
        .parse(await thread.json());
      return { running: snapshot.activeRun !== undefined, messages: snapshot.messages.length };
    })
    .toEqual({ running: false, messages: 2 });
  return conversation;
}

/** `count` listed conversations, a few at a time so the instance's run limits are not met. */
async function createListedConversations(
  page: Page,
  collaborationWorkspaceId: string,
  count: number,
  titlePrefix: string
): Promise<void> {
  const atOnce = 4;
  for (let done = 0; done < count; done += atOnce) {
    await Promise.all(
      Array.from({ length: Math.min(atOnce, count - done) }, (_, index) =>
        createListedConversation(page, collaborationWorkspaceId, `${titlePrefix} ${done + index}`)
      )
    );
  }
}
