import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const member = { email: "e2e-user@example.test", password: "e2e-user-password" };
/** May decide skill changes, so the rail shows this person the Inbox row. */
const reviewer = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

/** As many conversations as the rail lists under "Recent" (`RAIL_RECENT_LIMIT`). */
const railRecentLimit = 30;
/** As many conversations as the full list reads at once (`CONVERSATION_LIST_PAGE_SIZE`). */
const listPageSize = 50;
/** How often the rail reads its conversations again while it must (`RAIL_REFRESH_INTERVAL_MS`). */
const railRefreshIntervalMs = 2_000;
/**
 * The fixture model echoes a message one word every 20 ms, so this many words are a run of
 * about ten seconds.
 */
const longRunWords = 500;

const rail = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
const listPage = (page: Page) => page.getByRole("region", { name: "Conversations", exact: true });

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

// Fails without the list of every conversation: the rail listed all of them, had no "Show all"
// row, and `/w/<workspace>/conversations` opened the application root.
test("Show all appears past the rail's cap and opens the full list, whose search finds an older conversation and whose row opens it", async ({
  page
}) => {
  test.setTimeout(180_000);
  await signIn(page, member);
  const stamp = Date.now();
  const workspace = await createWorkspace(page, `All conversations ${stamp}`);
  const workspacePath = `/w/${encodeURIComponent(workspace.id)}`;
  const navigation = rail(page);
  const list = listPage(page);
  const rows = list.getByTestId("conversation-list-row");
  const railRows = navigation.getByTestId("conversation-row");
  const showAll = navigation.getByRole("button", { name: "Show all", exact: true });

  // An empty workspace says so on the list and offers the one way to start.
  await page.goto(`${workspacePath}/conversations`);
  await expect(list.getByRole("heading", { name: "Conversations", level: 1 })).toBeFocused();
  await expect(list.getByText("No conversations yet.")).toBeVisible();
  await expect(list.getByRole("button", { name: "New chat" })).toBeVisible();

  // The oldest conversation is the one the search has to find later.
  const oldestTitle = `Mietvertrag Altbau ${stamp}`;
  const oldest = await createListedConversation(page, workspace.id, oldestTitle);
  // Another old one, which is later opened by its address, renamed and deleted from the rail.
  const olderTitle = `Kaufvertrag Neubau ${stamp}`;
  const older = await createListedConversation(page, workspace.id, olderTitle);
  await createListedConversations(page, workspace.id, railRecentLimit - 2, `Filler ${stamp} a`);

  // With exactly as many as the rail shows, the rail shows them all and needs no further row.
  await page.goto(workspacePath);
  await expect(railRows).toHaveCount(railRecentLimit);
  await expect(railRows.filter({ hasText: oldestTitle })).toHaveCount(1);
  await expect(showAll).toHaveCount(0);

  await createListedConversations(
    page,
    workspace.id,
    listPageSize + 2 - railRecentLimit,
    `Filler ${stamp} b`
  );
  await page.reload();
  await expect(railRows).toHaveCount(railRecentLimit);
  await expect(railRows.filter({ hasText: oldestTitle })).toHaveCount(0);
  await expect(showAll).toBeVisible();
  // The quiet row ends the list.
  await expect(
    navigation.getByRole("group", { name: "Recent" }).getByRole("button").last()
  ).toHaveText("Show all");

  const searches: string[] = [];
  const pageRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname !== "/api/v1/conversations" || url.searchParams.get("limit") !== "50") {
      return;
    }
    pageRequests.push(url.searchParams.get("cursor") ?? "");
    const query = url.searchParams.get("query");
    if (query !== null) {
      searches.push(query);
    }
  });

  await showAll.click();
  await expect(page).toHaveURL(new RegExp(`${workspacePath}/conversations$`, "u"));
  await expect(list.getByRole("heading", { name: "Conversations", level: 1 })).toBeFocused();
  await expect(showAll).toHaveAttribute("aria-current", "true");
  // One page arrives, not the whole list: the oldest conversation is not on it.
  await expect(rows).toHaveCount(listPageSize);
  await expect(rows.filter({ hasText: oldestTitle })).toHaveCount(0);
  await expect(rows.first().locator("time")).toHaveText(/ago|now/u);
  expect(pageRequests).toEqual([""]);

  // The older rows come on request.
  await list.getByRole("button", { name: "Show more" }).click();
  await expect(rows).toHaveCount(listPageSize + 2);
  await expect(rows.last()).toContainText(oldestTitle);
  await expect(list.getByRole("button", { name: "Show more" })).toHaveCount(0);
  expect(pageRequests).toHaveLength(2);

  // The search is answered by the server, without regard to case.
  const search = list.getByRole("searchbox", { name: "Search conversations" });
  await search.fill(`mietvertrag altbau ${stamp}`);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(oldestTitle);
  expect(searches).toEqual([`mietvertrag altbau ${stamp}`]);
  await search.fill(`Nothing is called this ${stamp}`);
  await expect(
    list.getByText(`No results for "Nothing is called this ${stamp}" in ${workspace.name}.`)
  ).toBeVisible();
  await search.fill(`Altbau ${stamp}`);
  await expect(rows).toHaveCount(1);

  // The keyboard reaches the row and its menu.
  await search.focus();
  await page.keyboard.press("Tab");
  await expect(rows.first().getByRole("button").first()).toBeFocused();
  await expect(rows.first().getByRole("button").first()).toContainText(oldestTitle);
  await page.keyboard.press("Tab");
  const rowMenu = rows
    .first()
    .getByRole("button", { name: `Conversation options for ${oldestTitle}` });
  await expect(rowMenu).toBeFocused();

  // A row opens its conversation, and the rail then holds the older one as the current row,
  // after the latest ones.
  await rows.first().getByRole("button").first().click();
  await expect(page).toHaveURL(
    new RegExp(`${workspacePath}/c/${encodeURIComponent(oldest.id)}$`, "u")
  );
  await expect(page.getByText(`Opening message for ${oldestTitle}`, { exact: true })).toBeVisible();
  await expect(railRows).toHaveCount(railRecentLimit + 1);
  await expect(railRows.last()).toContainText(oldestTitle);
  await expect(railRows.last()).toHaveAttribute("data-selected", "true");

  // The address without a workspace leads to the list of the active one. A row's menu renames
  // like the rail's, and deletes after one question.
  await page.goto("/conversations");
  await expect(page).toHaveURL(new RegExp(`${workspacePath}/conversations$`, "u"));
  await search.fill(`Altbau ${stamp}`);
  await expect(rows).toHaveCount(1);
  await rowMenu.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Rename conversation" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename conversation" });
  // Still matches the search, so the row stays.
  const renamedTitle = `Mietvertrag umbenannt Altbau ${stamp}`;
  await renameDialog.getByRole("textbox", { name: "Conversation title" }).fill(renamedTitle);
  await page.keyboard.press("Enter");
  await expect(renameDialog).toBeHidden();
  await expect(rows.first()).toContainText(renamedTitle);
  // A menu opened in the instant the rename dialog leaves the page closes again (measured:
  // within about 130 ms of the dialog closing; from 150 ms on it stays). A person is slower
  // than that, the test asks again.
  const deleteItem = page.getByRole("menuitem", { name: "Delete conversation" });
  await expect(async () => {
    if (!(await deleteItem.isVisible())) {
      await rows
        .first()
        .getByRole("button", { name: `Conversation options for ${renamedTitle}` })
        .click({ timeout: 2_000 });
    }
    await deleteItem.click({ timeout: 1_000 });
  }).toPass();
  const deleteDialog = page.getByRole("dialog", { name: "Delete conversation?" });
  await expect(deleteDialog).toContainText(renamedTitle);
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    list.getByText(`No results for "Altbau ${stamp}" in ${workspace.name}.`)
  ).toBeVisible();

  // Fails without the one page: the rail then asked for pages of 200 until the list ended, and
  // found the open conversation among all of them. Now it asks for its rows and one more, and
  // an older conversation opened by its address is the last row, from the thread on screen.
  const railReads = railListRequests(page);
  await page.goto(`${workspacePath}/c/${encodeURIComponent(older.id)}`);
  await expect(railRows).toHaveCount(railRecentLimit + 1);
  await expect(railRows.last()).toContainText(olderTitle);
  await expect(railRows.last()).toHaveAttribute("data-selected", "true");
  await expect(showAll).toBeVisible();
  expect(railReads()).toEqual([
    { collaborationWorkspaceId: workspace.id, limit: String(railRecentLimit + 1), cursor: null }
  ]);

  // The row renames and deletes like every other row of the rail.
  await railRows
    .last()
    .getByRole("button", { name: `Conversation options for ${olderTitle}` })
    .click();
  await page.getByRole("menuitem", { name: "Rename conversation", exact: true }).click();
  const railTitle = page.getByRole("textbox", { name: "Conversation title", exact: true });
  await expect(railTitle).toHaveValue(olderTitle);
  const renamedOlderTitle = `Kaufvertrag umbenannt ${stamp}`;
  await railTitle.fill(renamedOlderTitle);
  await railTitle.press("Enter");
  const renamedOlderRow = railRows.filter({ hasText: renamedOlderTitle });
  await expect(renamedOlderRow).toHaveCount(1);
  await expect(renamedOlderRow).toHaveAttribute("data-selected", "true");
  await expect(railRows.filter({ hasText: olderTitle })).toHaveCount(0);

  const deleteFromRail = page.getByRole("menuitem", { name: "Delete conversation", exact: true });
  await expect(async () => {
    if (!(await deleteFromRail.isVisible())) {
      await renamedOlderRow
        .getByRole("button", { name: `Conversation options for ${renamedOlderTitle}` })
        .click({ timeout: 2_000 });
    }
    await deleteFromRail.click({ timeout: 1_000 });
  }).toPass();
  await page
    .getByRole("dialog", { name: "Delete conversation?", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  // The latest conversation opens in its place, and older ones are still a row away.
  await expect(renamedOlderRow).toHaveCount(0);
  await expect(railRows).toHaveCount(railRecentLimit);
  await expect(railRows.first()).toHaveAttribute("data-selected", "true");
  await expect(page).not.toHaveURL(new RegExp(encodeURIComponent(older.id), "u"));
  await expect(showAll).toBeVisible();
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
    limit: String(railRecentLimit + 1),
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

// Fails without the change: the collapsed rail had no way to the conversations, since the
// strip hides the list under "Recent".
test("the collapsed rail keeps New chat and opens the list of every conversation", async ({
  page
}) => {
  await signIn(page, member);
  const navigation = rail(page);

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(navigation.getByTestId("conversation-row")).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  const strip = navigation.getByRole("button");
  await expect(strip.nth(0)).toHaveAccessibleName("Expand sidebar");
  await expect(strip.nth(1)).toHaveAccessibleName("Search");
  await expect(strip.nth(2)).toHaveAccessibleName("New chat");
  await expect(strip.nth(3)).toHaveAccessibleName("Conversations");

  const conversations = navigation.getByRole("button", { name: "Conversations", exact: true });
  await conversations.hover();
  await expect(page.getByRole("tooltip", { name: "Conversations" })).toBeVisible();
  await conversations.click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/conversations$/u);
  await expect(conversations).toHaveAttribute("aria-current", "true");
  await expect(
    listPage(page).getByRole("heading", { name: "Conversations", level: 1 })
  ).toBeVisible();

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
 * What the rail has asked the conversation list for so far. The full list page asks with its
 * own page size and the palette with a search text; everything else on that path is the rail.
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
      url.searchParams.get("limit") === String(listPageSize) ||
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
