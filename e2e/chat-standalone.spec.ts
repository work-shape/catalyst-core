import { apiOperations } from "@work-shape/catalyst-api-contract";
import { expect } from "./test";
import {
  apiBaseUrl,
  normalUser,
  test,
  createListedConversation,
  collaborationWorkspaceUrlPattern,
  collaborationWorkspaceConversationUrlPattern,
  conversationUrlPattern,
  LONG_RUN_END_TIMEOUT_MS,
  LONG_RUN_TEST_TIMEOUT_MS,
  holdAnswer,
  holdGet,
  longRunMessage,
  isRunEventsPath,
  currentConversationId,
  countRequests,
  countResponses,
  readPagedList
} from "./chat-fixtures";

// The core chat flows in a real browser: sign in, send a first message and read the streamed
// answer, stop a reply, and switch conversations while a reply streams. Everything else of the
// chat is proved by the vitest suites in tests/.

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.describe("login", () => {
  test.use({ sessionUser: "anonymous" });
  test("standalone login renders the authenticated chat workspace", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Email").fill(normalUser.email);
    await page.getByLabel("Password").fill(normalUser.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByRole("button", { name: "E2E User account" })).toBeVisible();
    await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
    await expect(page.getByPlaceholder("Message")).toBeVisible();
  });
});

test("first message from the root route is answered in the persisted conversation route", async ({
  page
}) => {
  const releaseWorkspaces = await holdGet(page, (path) => path === "/api/v1/workspaces");
  const creates = countRequests(page, "POST", (path) => path === "/api/v1/conversations/runs");
  const messageText = `Route creation ${Date.now()}`;
  const createRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/conversations/runs"
  );
  let releaseCreate = () => {};
  const createGate = new Promise<void>((done) => {
    releaseCreate = done;
  });
  await page.route(`${apiBaseUrl}/api/v1/conversations/runs`, async (route) => {
    if (route.request().method() === "POST") await createGate;
    await route.continue();
  });
  await page.goto("/");
  const input = page.getByPlaceholder("Message");
  const send = page.getByRole("button", { name: "Send message" });
  await input.fill(`${messageText} draft`);
  await input.press("Enter");
  await expect(send).toHaveAttribute("aria-busy", "true");
  await input.fill(messageText);
  await expect(send).not.toHaveAttribute("aria-busy", "true");
  await input.press("Enter");
  await expect(send).toHaveAttribute("aria-busy", "true");
  expect(creates()).toBe(0);
  releaseWorkspaces();
  await expect.poll(creates).toBe(1);
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  await expect(input).toHaveValue(messageText);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.locator('[data-role="user"]').filter({ hasText: messageText })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
  releaseCreate();
  const response = await createRunResponse;
  expect(response.ok()).toBe(true);
  const started = apiOperations["conversations.runs.create"].response.schema.parse(
    await response.json()
  );

  await expect(page).toHaveURL(conversationUrlPattern(started.conversation.id));
  await expect(page.locator('[data-role="user"]')).toHaveText([messageText]);
  await expect(input).toHaveValue("");
  // The local agent streams its answer, which quotes the message.
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(messageText);
  const createdConversation = page.getByTestId("conversation-row").filter({ hasText: messageText });
  await expect(createdConversation).toHaveAttribute("data-selected", "true");

  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  await expect(page.getByPlaceholder("Message")).toHaveValue("");
  await expect(createdConversation).toHaveCount(1);
  expect(creates()).toBe(1);
});

test("stop generating cancels the active stream instead of only hiding the button", async ({
  page
}) => {
  // Keep the answer off the page until Stop has acted, as in the active-run guard test.
  const releaseAnswer = await holdAnswer(page);
  const answeredEventStreams = countResponses(page, "GET", isRunEventsPath);

  await page.goto("/");
  const suffix = Date.now();
  const input = page.getByPlaceholder("Message");
  const lateToken = `stop-late-token-${suffix}`;
  const messageText = `${longRunMessage(`stop-token-${suffix}`)} ${lateToken}`;
  await input.fill(messageText);
  await input.press("Enter");
  await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);

  const stopButton = page.getByRole("button", { name: "Stop generating" });
  const cancellationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /^\/api\/v1\/conversations\/[^/]+\/runs\/[^/]+\/cancel$/u.test(
        new URL(response.url()).pathname
      )
  );
  try {
    await expect(stopButton).toBeVisible();
    await expect(stopButton).toBeEnabled();
    expect(answeredEventStreams()).toBe(0);
    await stopButton.click({ timeout: 5_000 });
  } finally {
    releaseAnswer();
  }
  const cancelled = await cancellationResponse;
  expect(cancelled.ok()).toBe(true);
  const { run } = apiOperations["conversations.runs.cancel"].response.schema.parse(
    await cancelled.json()
  );

  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 10_000 });
  await expect(stopButton).toHaveCount(0);
  const conversationId = currentConversationId(page);
  // Wait for persisted cancellation, rather than sleeping for the old short run's duration.
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `${apiBaseUrl}/api/v1/conversations/${conversationId}/thread`
      );
      expect(response.ok()).toBe(true);
      const thread = apiOperations["conversations.thread.get"].response.schema.parse(
        await response.json()
      );
      return thread.activeRun?.run.id === run.id ? thread.activeRun.run.status : undefined;
    })
    .toBe("cancelled");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: lateToken })).toHaveCount(
    0
  );

  const persistedMessages = await readPagedList(
    page,
    `/api/v1/conversations/${conversationId}/messages`,
    apiOperations["conversations.messages.list"].response.schema
  );
  const persistedAssistantText = persistedMessages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");
  expect(persistedAssistantText).not.toContain(lateToken);
});

test(
  "conversation switching isolates pending stream state",
  { tag: "@chat-state" },
  async ({ page }) => {
    const suffix = Date.now();
    const messageToken = `session-isolation-${suffix}`;
    const sourceConversation = page.getByTestId("conversation-row").filter({
      has: page.getByTitle(new RegExp(messageToken, "iu"))
    });
    const targetTitle = `Stable target ${suffix}`;
    let sourceId = "";
    const target = await createListedConversation(page, targetTitle);

    test.setTimeout(LONG_RUN_TEST_TIMEOUT_MS);
    // Keep the source answer pending while switching, then finish it in the background.
    const releaseAnswer = await holdAnswer(page);
    const eventConversations: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === "GET" && isRunEventsPath(pathname)) {
        eventConversations.push(decodeURIComponent(pathname.split("/")[4] ?? ""));
      }
    });
    const answeredEventStreams = countResponses(page, "GET", isRunEventsPath);

    try {
      await page.goto("/");
      const input = page.getByPlaceholder("Message");
      const chatRegion = page.getByRole("region", { name: "Chat" });
      const targetConversation = page
        .getByTestId("conversation-row")
        .filter({ hasText: targetTitle });
      await expect(targetConversation).toHaveCount(1);

      const sendButton = page.getByRole("button", { name: "Send message" });
      await input.fill(longRunMessage(messageToken));
      await expect(sendButton).toBeEnabled();
      await sendButton.click();
      await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);
      sourceId = currentConversationId(page);
      // Generated titles animate their visible text; the title attribute arrives at once.
      await expect(sourceConversation).toHaveCount(1);
      await expect(chatRegion.getByText(messageToken, { exact: false }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
      await expect.poll(() => eventConversations.length).toBeGreaterThan(0);
      await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

      await targetConversation.getByRole("button").first().click();
      await expect(chatRegion.getByText(messageToken, { exact: false })).toHaveCount(0);
      await expect(page.getByTestId("run-activity")).toHaveCount(0);
      await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();
      expect(eventConversations.every((id) => id === sourceId)).toBe(true);

      // Back in the source the run shows as in progress and the composer offers to stop it
      // instead of sending.
      await sourceConversation.getByRole("button").first().click();
      await expect(page.getByTestId("run-activity")).toBeVisible();
      const stopButton = page.getByRole("button", { name: "Stop generating" });
      await expect(stopButton).toBeVisible();
      await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
      expect(answeredEventStreams()).toBe(0);
      await targetConversation.getByRole("button").first().click();
      await expect(targetConversation).toHaveAttribute("data-selected", "true");
      releaseAnswer();
      await expect
        .poll(
          async () => {
            const response = await page.request.get(
              `${apiBaseUrl}/api/v1/conversations/${sourceId}/thread`
            );
            expect(response.ok()).toBe(true);
            const thread = apiOperations["conversations.thread.get"].response.schema.parse(
              await response.json()
            );
            return {
              active: thread.activeRun !== undefined,
              answered: thread.messages.some(
                (message) => message.role === "assistant" && message.text.includes(messageToken)
              )
            };
          },
          { timeout: LONG_RUN_END_TIMEOUT_MS }
        )
        .toEqual({ active: false, answered: true });
      await expect(sourceConversation.getByTestId("conversation-running-indicator")).toHaveCount(0);
      await expect(page).toHaveURL(conversationUrlPattern(target.id));
      await expect(targetConversation).toHaveAttribute("data-selected", "true");
      await expect(chatRegion.getByText(messageToken, { exact: false })).toHaveCount(0);
      await expect(page.getByTestId("run-activity")).toHaveCount(0);
      await expect(chatRegion.locator('[data-role="user"]')).toHaveText([
        `Opening message for ${targetTitle}`
      ]);
      await expect(chatRegion.locator('[data-role="assistant"]')).toHaveCount(1);
      expect(eventConversations.length).toBeGreaterThan(0);
      expect(eventConversations.every((id) => id === sourceId)).toBe(true);
    } finally {
      releaseAnswer();
    }
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    // A send immediately after the switch belongs to the entered conversation. Read both
    // stored threads: the sender has access to both, so authorization cannot catch a mix-up.
    const userTexts = async (id: string) =>
      (
        await readPagedList(
          page,
          `/api/v1/conversations/${id}/messages`,
          apiOperations["conversations.messages.list"].response.schema
        )
      )
        .filter((message) => message.role === "user")
        .map((message) => message.text);
    const sourceBefore = await userTexts(sourceId);
    await sourceConversation.getByRole("button").first().click();
    await expect(page).toHaveURL(conversationUrlPattern(sourceId));
    await expect(
      page.getByRole("region", { name: "Chat" }).getByText(messageToken, { exact: false }).first()
    ).toBeVisible();
    await page
      .getByTestId("conversation-row")
      .filter({ hasText: targetTitle })
      .getByRole("button")
      .first()
      .click();
    const switchedText = `Sent right after the switch ${suffix}`;
    await page.getByPlaceholder("Message").fill(switchedText);
    await page.getByPlaceholder("Message").press("Enter");
    await expect(page).toHaveURL(conversationUrlPattern(target.id));
    await expect(
      page
        .getByRole("region", { name: "Chat" })
        .locator('[data-role="user"]')
        .getByText(switchedText, { exact: true })
    ).toBeVisible();
    await expect.poll(() => userTexts(target.id)).toContain(switchedText);
    expect(await userTexts(sourceId)).toEqual(sourceBefore);
  }
);
