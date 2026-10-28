import type { Locator } from "@playwright/test";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { expect } from "./test";
import {
  apiBaseUrl,
  normalUser,
  test,
  settingsGear,
  settingsPages,
  createListedConversation,
  legacyConversationPath,
  collaborationWorkspaceUrlPattern,
  collaborationWorkspaceConversationUrlPattern,
  conversationUrlPattern,
  COMPOSER_GROWTH_LINES,
  LONG_RUN_END_TIMEOUT_MS,
  LONG_RUN_TEST_TIMEOUT_MS,
  holdAnswer,
  holdGet,
  longRunMessage,
  isRunEventsPath,
  currentConversationId,
  countRequests,
  countResponses,
  openWorkHistoryToolCard,
  stopActiveRun,
  readPagedList
} from "./chat-fixtures";

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "reply-remote-image-refused",
        reason:
          "Chromium's own log line for an image the interface's content policy refused. The test " +
          "plants remote images in a Mermaid diagram of a reply and asserts no request left.",
        matches:
          /^Loading the image 'https:\/\/outside-pixel\.example\.test\/[^']*' violates the following Content Security Policy directive: "img-src [^"]*"\. The action has been blocked\.\s*$/u,
        tests: ["a reply with remote images, also in a Mermaid diagram, makes no request outside"]
      }
    ]
  }
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.describe("login", () => {
  test.use({ sessionUser: "anonymous" });
  test("standalone login renders the authenticated chat workspace", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveValue("");
    await expect(page.getByLabel("Password")).toHaveValue("");
    await page.getByLabel("Email").fill(normalUser.email);
    await page.getByLabel("Password").fill(normalUser.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByText("E2E Customer")).toBeVisible();
    await expect(page.getByText("E2E User")).toBeVisible();
    await expect(page.getByRole("button", { name: "E2E User account" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select agent" })).toHaveAccessibleName(
      "Select agent: Application Assistant"
    );
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New chat", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Language" })).toHaveCount(0);
    await expect(page.locator("header").getByText("Ready", { exact: true })).toHaveCount(0);
    await expect(settingsGear(page)).toHaveCount(0);

    await page.getByRole("button", { name: "E2E User account" }).click();
    await page.getByRole("menuitem", { name: "Profile" }).click();
    await expect(page).toHaveURL(/\/settings\/you\/profile$/u);
    await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
    await settingsPages(page).getByRole("button", { name: "Language and appearance" }).click();
    await expect(page.getByRole("combobox", { name: "Language" })).toBeVisible();
  });
});

test("the composer grows to six lines without a resize observer loop", async ({ page }) => {
  // The browser reports the loop as an error event on the window, without an exception.
  await page.addInitScript(() => {
    window.addEventListener("error", (event) => {
      if (event.message.includes("ResizeObserver")) {
        document.documentElement.dataset.resizeObserverLoops = String(
          Number(document.documentElement.dataset.resizeObserverLoops ?? 0) + 1
        );
      }
    });
  });
  await page.goto("/");
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);

  const input = page.getByPlaceholder("Message");
  await expect(input).toBeVisible();
  const lineHeight = async () =>
    input.evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
  const height = async () => input.evaluate((element) => element.getBoundingClientRect().height);
  const oneLine = await height();

  // Typed as a user types it: a long line that wraps, then line by line.
  await input.pressSequentially("A first line that is long enough to wrap in a compact composer ");
  for (let line = 2; line <= COMPOSER_GROWTH_LINES; line += 1) {
    await input.press("Shift+Enter");
    await input.pressSequentially(`line ${line}`);
  }
  await expect
    .poll(height)
    .toBeGreaterThanOrEqual(oneLine + (COMPOSER_GROWTH_LINES - 1) * (await lineHeight()) - 1);
  // And back to one line, which moves the controls beside the input again.
  await input.fill("");
  await expect.poll(height).toBe(oneLine);
  // Two frames, so an observer that fired on the last change has reported.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );

  expect(
    await page.evaluate(() => document.documentElement.dataset.resizeObserverLoops ?? "0")
  ).toBe("0");
});

test("composer sends on Enter and inserts a newline on Shift+Enter", async ({ page }) => {
  await page.goto("/");
  let createRunRequests = 0;
  let legacyChatRequests = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/v1/conversations/runs") {
      createRunRequests += 1;
    }
    if (request.method() === "POST" && pathname === "/api/chat") {
      legacyChatRequests += 1;
    }
  });

  await page.goto("/");

  const input = page.getByPlaceholder("Message");
  await expect(input).toBeVisible();

  const messageText = `Keyboard submit ${Date.now()}`;
  await input.fill(messageText);
  await input.focus();
  await page.keyboard.down("Shift");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Shift");
  await expect(input).toHaveValue(`${messageText}\n`);
  expect(createRunRequests).toBe(0);
  expect(legacyChatRequests).toBe(0);

  const createRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/conversations/runs"
  );
  await input.press("Enter");
  await createRunResponse;

  expect(createRunRequests).toBe(1);
  expect(legacyChatRequests).toBe(0);
  await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);
  await expect(input).toHaveValue("");
});

test("a reply with remote images, also in a Mermaid diagram, makes no request outside", async ({
  page
}) => {
  const outsideHost = "outside-pixel.example.test";
  const isOutside = (address: string) => new URL(address).hostname === outsideHost;
  // Chromium reports a load the content policy refused as a request that failed with the
  // reason "csp"; such a request never reaches the network. Every other outcome counts.
  const outsideRequests: string[] = [];
  const refusedByPolicy: string[] = [];
  page.on("request", (request) => {
    if (isOutside(request.url())) {
      outsideRequests.push(request.url());
    }
  });
  page.on("requestfailed", (request) => {
    if (isOutside(request.url()) && request.failure()?.errorText === "csp") {
      refusedByPolicy.push(request.url());
    }
  });
  // A request that did reach the network would be answered here.
  const answered: string[] = [];
  await page.route(`**://${outsideHost}/**`, async (route) => {
    answered.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "image/gif", body: Buffer.alloc(0) });
  });

  await page.goto("/");

  // The fixture agent quotes the message in its reply, so the reply carries the same Markdown.
  // The last line keeps the diagram's closing fence apart from the rest of the reply.
  const input = page.getByPlaceholder("Message");
  await input.fill(
    [
      "Pixel check",
      "",
      `![Markdown image](https://${outsideHost}/markdown.png)`,
      "",
      `<img src="https://${outsideHost}/html.gif" width="1" height="1" alt="">`,
      "",
      "```mermaid",
      `%%{init: {"themeCSS": ".label { background-image: url(https://${outsideHost}/theme.png) }"}}%%`,
      "flowchart TD",
      `  A["<img src='https://${outsideHost}/label.png' width='16' /> Label node"] --> B[Plain node]`,
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      `  C@{ img: "https://${outsideHost}/shape.png", label: "Image shape", pos: "t", w: 60, h: 60, constraint: "on" }`,
      "```",
      "",
      "End of check"
    ].join("\n")
  );
  await input.press("Enter");

  const reply = page
    .getByRole("region", { name: "Chat" })
    .locator('[data-role="assistant"]')
    .last();
  await expect(reply.locator("svg").getByText("Label node")).toBeVisible({ timeout: 20_000 });
  await expect(reply.getByText("Image not loaded: Markdown image")).toBeVisible();
  // The image shape is drawn, or refused by Mermaid itself once its image did not load.
  await expect(
    reply
      .locator("svg")
      .getByText("Image shape")
      .or(reply.getByText(/Mermaid Error/u))
  ).toBeVisible();
  // The final stream and both diagrams have finished before the observation window starts.
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
  await expect(reply.getByText("End of check", { exact: false })).toBeVisible();
  // Markdown and raw HTML images are removed. Both diagrams have now attempted their
  // background, label and shape URLs; the full set cannot pass on the first refusal.
  await expect
    .poll(() => [...new Set(outsideRequests.map((url) => new URL(url).pathname))].sort())
    .toEqual(["/label.png", "/shape.png", "/theme.png"]);
  // Every attempted image request has received its policy refusal.
  await expect
    .poll(() => outsideRequests.length > 0 && refusedByPolicy.length === outsideRequests.length)
    .toBe(true);

  expect(answered).toEqual([]);
  expect(outsideRequests.length).toBeGreaterThan(0);
  expect(refusedByPolicy.sort()).toEqual(outsideRequests.sort());
});

test("first message from the root route moves to the persisted conversation route", async ({
  page
}) => {
  const releaseWorkspaces = await holdGet(page, (path) => path === "/api/v1/workspaces");
  let legacyChatRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") {
      legacyChatRequests += 1;
    }
  });

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
  const started = (await response.json()) as { conversation: { id: string } };

  await expect(page).toHaveURL(conversationUrlPattern(started.conversation.id));
  expect(legacyChatRequests).toBe(0);
  await expect(page.locator('[data-role="user"]')).toHaveText([messageText]);
  await expect(input).toHaveValue("");
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
  // The person reads a sentence, never the reason code the request carried.
  await expect(page.getByText("The reply was stopped.")).toBeVisible();
  await expect(page.getByText("user_requested")).toHaveCount(0);

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

test("composer drafts are scoped to the new screen and selected conversations", async ({
  page
}) => {
  const title = `Draft target ${Date.now()}`;
  await createListedConversation(page, title);

  await page.goto("/");
  const input = page.getByPlaceholder("Message");
  await input.fill("New screen draft");

  const targetConversation = page.getByTestId("conversation-row").filter({ hasText: title });
  await expect(targetConversation).toHaveCount(1);
  await targetConversation.getByRole("button").first().click();
  await expect(input).toHaveValue("");
  await input.fill("Selected conversation draft");

  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(input).toHaveValue("New screen draft");

  await targetConversation.getByRole("button").first().click();
  await expect(input).toHaveValue("Selected conversation draft");
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

test(
  "direct conversation links resume a running stream from stored state",
  { tag: "@chat-state" },
  async ({ page }) => {
    test.setTimeout(LONG_RUN_TEST_TIMEOUT_MS);

    const suffix = Date.now();
    const sourceTitle = `Direct resume source ${suffix}`;
    const conversation = await createListedConversation(page, sourceTitle);

    const eventRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && isRunEventsPath(url.pathname)) {
        eventRequests.push(request.url());
      }
    });

    const releaseAnswer = await holdAnswer(page);
    await page.goto(legacyConversationPath(conversation.id));
    const input = page.getByPlaceholder("Message");
    const chatRegion = page.getByRole("region", { name: "Chat" });
    const sourceConversation = page
      .getByTestId("conversation-row")
      .filter({ hasText: sourceTitle });
    await expect(sourceConversation).toHaveCount(1);

    const uniqueToken = `direct-resume-token-${suffix}`;
    await input.fill(longRunMessage(uniqueToken));
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

    releaseAnswer();
    await page.goto(legacyConversationPath(conversation.id));
    await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();
    await expect(sourceConversation).toHaveAttribute("data-selected", "true");
    await expect.poll(() => eventRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(
      chatRegion.locator('[data-role="assistant"]').filter({ hasText: uniqueToken }).first()
    ).toBeVisible({
      timeout: 15_000
    });
    await expect(page.getByTestId("run-activity")).toHaveCount(0, {
      timeout: LONG_RUN_END_TIMEOUT_MS
    });
    await stopActiveRun(page);
  }
);

test("conversation rail deletes a conversation", async ({ page }) => {
  let deleteConversationRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "DELETE" &&
      /^\/api\/v1\/conversations\/[^/]+$/u.test(new URL(request.url()).pathname)
    ) {
      deleteConversationRequests += 1;
    }
  });

  const title = `Delete target ${Date.now()}`;
  await createListedConversation(page, title);

  await page.goto("/");
  const conversations = page.getByTestId("conversation-row");
  const targetConversation = conversations.filter({ hasText: title });
  await expect(targetConversation).toHaveCount(1);

  const conversationCountBefore = await conversations.count();
  // While the workspace holds older conversations than the loaded page, the next older one
  // moves up into the place of the deleted one.
  const railHasOlder =
    (await page.getByRole("button", { name: "Load more", exact: true }).count()) > 0;
  const optionsButton = targetConversation.getByRole("button", {
    name: `Conversation options for ${title}`,
    exact: true
  });
  await expect(optionsButton).toBeVisible();
  await optionsButton.click();
  await page.getByRole("menuitem", { name: "Delete conversation", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Delete conversation?", exact: true })
  ).toBeVisible();
  expect(deleteConversationRequests).toBe(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Delete conversation?", exact: true })).toHaveCount(
    0
  );

  await optionsButton.click();
  await page.getByRole("menuitem", { name: "Delete conversation", exact: true }).click();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        /^\/api\/v1\/conversations\/[^/]+$/u.test(new URL(response.url()).pathname)
    ),
    page.getByRole("button", { name: "Delete", exact: true }).click()
  ]);

  expect(deleteConversationRequests).toBe(1);
  await expect(targetConversation).toHaveCount(0);
  await expect(conversations).toHaveCount(
    railHasOlder ? conversationCountBefore : conversationCountBefore - 1
  );
});

test("conversation rail renames from the menu and a later selected-title click", async ({
  page
}) => {
  const initialTitle = `Rename target ${Date.now()}`;
  const menuTitle = `${initialTitle} menu`;
  const finalTitle = `${initialTitle} double click`;
  const renameTarget = await createListedConversation(page, initialTitle);
  let releaseRename = () => {};
  const renameReleased = new Promise<void>((resolve) => (releaseRename = resolve));
  await page.route(
    "**/api/v1/conversations/*/title",
    async (route) => {
      await renameReleased;
      await route.continue();
    },
    { times: 1 }
  );

  await page.goto("/");
  const initialRow = page.getByTestId("conversation-row").filter({ hasText: initialTitle });
  await expect(initialRow).toHaveCount(1);
  await expect(initialRow.locator(".lucide-message-square")).toHaveCount(0);

  await initialRow
    .getByRole("button", { name: `Conversation options for ${initialTitle}` })
    .click();
  await page.getByRole("menuitem", { name: "Rename conversation", exact: true }).click();
  const titleInput = page.getByRole("textbox", { name: "Conversation title", exact: true });
  await expect(titleInput).toBeFocused();
  await expect(titleInput).toHaveValue(initialTitle);
  await titleInput.fill(menuTitle);
  const menuRenameResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/api\/v1\/conversations\/[^/]+\/title$/u.test(new URL(response.url()).pathname)
  );
  await titleInput.press("Enter");
  expect(await titleInput.count()).toBe(0);
  releaseRename();
  await menuRenameResponse;

  const renamedRow = page.getByTestId("conversation-row").filter({ hasText: menuTitle });
  await expect(renamedRow).toHaveCount(1);
  await renamedRow.getByRole("button").first().click();
  await expect(renamedRow).toHaveAttribute("data-selected", "true");
  await expect(page).toHaveURL(conversationUrlPattern(renameTarget.id));
  await expect(
    page
      .getByRole("region", { name: "Chat" })
      .getByText(`Opening message for ${initialTitle}`, { exact: false })
      .first()
  ).toBeVisible();
  await expect(titleInput).toHaveCount(0);
  await renamedRow.getByText(menuTitle, { exact: true }).click();
  await expect(titleInput).toBeFocused();
  await expect(titleInput).toHaveValue(menuTitle);
  await titleInput.fill(finalTitle);
  const doubleClickRenameResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/api\/v1\/conversations\/[^/]+\/title$/u.test(new URL(response.url()).pathname)
  );
  await titleInput.press("Enter");
  expect(await titleInput.count()).toBe(0);
  await doubleClickRenameResponse;
  const finalRow = page.getByTestId("conversation-row").filter({ hasText: finalTitle });
  await expect(finalRow).toHaveCount(1);
});

test.describe("admin widget", () => {
  test.use({ sessionUser: "superadmin" });
  test("demo chat can run a configured tool widget", async ({ page }) => {
    // A tool run, the work history and three settings pages: 21 seconds on an ordinary hosted
    // runner, and over the default of 30 on a slower one.
    test.setTimeout(60_000);
    const forecastLocation = `Oslo ${Date.now()}`;
    const consoleErrors: string[] = [];
    let historyResponses = 0;
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(error.message);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (
        response.request().method() === "GET" &&
        /^\/api\/v1\/conversations\/[^/]+\/(?:messages|thread)$/u.test(url.pathname)
      ) {
        historyResponses += 1;
      }
    });

    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await page
      .getByPlaceholder("Message")
      .fill(
        `/tool demo.weather_forecast {"location":"${forecastLocation}","days":3,"unit":"celsius","startDate":"2026-06-13"}`
      );
    await page.getByRole("button", { name: "Send message" }).click();

    const chatRegion = page.getByRole("region", { name: "Chat" });
    await expect(page.getByText("Tool work completed").last()).toBeVisible();
    await expect(page.getByTestId("run-activity")).toHaveCount(0);
    await expect.poll(() => historyResponses).toBeGreaterThan(0);

    // Once the run has finished the widget stands below the answer.
    await expect(chatRegion.getByText("Weather forecast", { exact: true })).toBeVisible();
    await expect(chatRegion.getByText(forecastLocation, { exact: true })).toBeVisible();
    await expect(chatRegion.getByText("3-day forecast", { exact: true })).toBeVisible();

    // The tool call itself is kept in the work history of the finished run.
    const toolCallCard = await openWorkHistoryToolCard(chatRegion);
    await expect(toolCallCard).toContainText("Weather Forecast");
    // The row says what happened and no status word; the input and output stay out of the page
    // until "Technical details" is opened (UXA-7b).
    await expect(toolCallCard).not.toContainText("Completed");
    await expect(toolCallCard.locator("pre")).toHaveCount(0);

    await settingsGear(page).click();
    await expect(settingsPages(page)).toBeVisible();
    // You and Instance each have a Usage page; the budget and safeguards are the instance's.
    await settingsPages(page)
      .getByRole("group", { name: "Instance", exact: true })
      .getByRole("button", { name: "Usage", exact: true })
      .click();
    await expect(page.getByTestId("usage-month-budget")).toBeVisible();
    await expect(page.getByText("Billable today")).toBeVisible();
    await expect(page.getByTestId("daily-usage")).toBeVisible();
    await expect(page.getByTestId("monthly-usage")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Safeguards per person", exact: true })
    ).toBeVisible();
    const configuredSafeguards = page.getByTestId("configured-safeguards");
    await expect(configuredSafeguards).toContainText("500");
    await expect(configuredSafeguards).toContainText("25,000");
    // The calls themselves are on their own tab.
    await page.getByRole("tab", { name: "Recent calls", exact: true }).click();
    await expect(page.getByText("Recent model usage")).toBeVisible();
    await expect(page.getByText("deterministic-local").first()).toBeVisible();
    await expect(page.getByText("No usage reported").first()).toBeVisible();
    await settingsPages(page).getByRole("button", { name: "Audit", exact: true }).click();
    await expect(page.getByText("Recent activity")).toBeVisible();
    // Tool runs are folded into their activity as evidence; expand the rows to reveal them.
    const adminRegion = page.getByRole("region", { name: "Settings" });
    const activityRows = adminRegion.locator("button[data-audit-activity]");
    const rowCount = await activityRows.count();
    for (let index = 0; index < rowCount; index += 1) {
      await activityRows.nth(index).click();
    }
    // Each event is said in words, never as its type (UXA-1b2).
    await expect(page.getByText("Ran a call").first()).toBeVisible();
    await expect(page.getByText("operation.completed")).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  });
});

test("under 768 px the rail is a drawer that the header opens and a choice closes", async ({
  page
}) => {
  await page.setViewportSize({ width: 700, height: 800 });

  const title = `Rail drawer ${Date.now()}`;
  const { id } = await createListedConversation(page, title);
  await page.goto("/");

  const drawer = page.getByRole("dialog", { name: "Main navigation" });
  const openDrawer = page.getByRole("button", { name: "Open sidebar" });
  await expect(openDrawer).toBeVisible();
  await expect(drawer).toBeHidden();
  await openDrawer.click();
  await expect(drawer).toBeVisible();
  expect((await drawer.boundingBox())?.width).toBe(280);
  // A drawer has no collapsed strip, so it offers no control for one.
  await expect(drawer.getByRole("button", { name: "Collapse sidebar" })).toBeHidden();
  await expect(drawer.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "E2E User account" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(openDrawer).toBeFocused();

  await openDrawer.click();
  await drawer
    .getByTestId("conversation-row")
    .filter({ hasText: title })
    .getByRole("button")
    .first()
    .click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(conversationUrlPattern(id));

  // From 768 px the rail stands in the layout again.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(openDrawer).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
});

test("the command palette opens from the rail and the keyboard, searches titles on the server and opens a conversation", async ({
  page,
  accessState: _accessState
}) => {
  const stamp = Date.now();
  const alphaTitle = `Palette alpha ${stamp}`;
  const betaTitle = `Palette beta ${stamp}`;
  const olderTitles = Array.from({ length: 7 }, (_, index) => `Recent cap ${index} ${stamp}`);
  for (const title of olderTitles) await createListedConversation(page, title);
  const { id: alphaId } = await createListedConversation(page, alphaTitle);
  await createListedConversation(page, betaTitle);
  let searches = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/conversations" && url.searchParams.has("query")) {
      searches += 1;
    }
  });
  await page.goto("/");
  await expect(page.getByTestId("conversation-row").filter({ hasText: betaTitle })).toBeVisible();

  const palette = page.getByRole("dialog", { name: "Search" });
  const field = palette.getByRole("combobox", { name: "Search" });
  const searchButton = page.getByRole("button", { name: "Search", exact: true });
  const composer = page.getByPlaceholder("Message");

  // From the rail: New chat with its keys, then the loaded conversations, without a request.
  await searchButton.click();
  await expect(palette).toBeVisible();
  await expect(field).toBeFocused();
  await expect(palette.getByRole("option").first()).toContainText("New chat");
  await expect(palette.getByRole("option").first()).toContainText(/⌘⇧O|Ctrl\+Shift\+O/u);
  await expect(palette.getByText("Recent", { exact: true })).toBeVisible();
  await expect(palette.getByRole("option", { name: alphaTitle })).toBeVisible();
  await expect(palette.getByRole("option", { name: betaTitle })).toBeVisible();
  await expect(palette.getByRole("group", { name: "Recent" }).getByRole("option")).toHaveText([
    betaTitle,
    alphaTitle,
    ...olderTitles.slice(1).reverse()
  ]);
  // "Go to" lists the Settings pages this user may open and nothing of the instance.
  await expect(palette.getByText("Go to", { exact: true })).toBeVisible();
  // Each Settings page is named with its group.
  await expect(palette.getByRole("option", { name: "You › Profile", exact: true })).toBeVisible();
  await expect(palette.getByRole("option", { name: "You › Security", exact: true })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Users/u })).toHaveCount(0);
  await expect(palette.getByRole("option", { name: "Studio", exact: true })).toHaveCount(0);
  expect(searches).toBe(0);
  // Escape closes it and the focus is back on what opened it.
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(searchButton).toBeFocused();

  // From the keyboard, also out of a text field. What is typed is searched on the server.
  await composer.click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  await field.fill(olderTitles[0] ?? "");
  await expect(palette.getByRole("option")).toHaveText([olderTitles[0] ?? ""]);
  await field.fill("");
  await page.keyboard.type(`ALPHA ${stamp}`);
  await expect(palette.getByRole("option")).toHaveCount(1);
  await expect(palette.getByRole("option", { name: alphaTitle })).toBeVisible();
  await expect(palette.getByText("Conversations", { exact: true })).toBeVisible();
  await expect(palette.getByText("New chat")).toHaveCount(0);
  expect(searches).toBeGreaterThan(0);

  await field.fill(`nothing ${stamp}`);
  // The search is limited to the active workspace, and the answer says so.
  await expect(palette.getByRole("status")).toHaveText(
    `No results for "nothing ${stamp}" in E2E's workspace.`
  );
  await expect(palette.getByRole("option")).toHaveCount(0);

  // Enter opens the conversation and puts the focus in the composer.
  await field.fill(`alpha ${stamp}`);
  await expect(palette.getByRole("option", { name: alphaTitle })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(conversationUrlPattern(alphaId));
  await expect(composer).toBeFocused();
});

// Where a file stands in a conversation, it carries the icon of its type: on the chip in the
// composer, on the label above the sent message and on its row in the Resources panel.

/** The files of the test with the icon each one gets. The instance takes these types. */
const files = [
  {
    name: "figures.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    icon: "spreadsheet"
  },
  { name: "letter.odt", mimeType: "application/vnd.oasis.opendocument.text", icon: "document" },
  {
    name: "slides.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    icon: "presentation"
  },
  { name: "notes.rtf", mimeType: "application/rtf", icon: "text" }
] as const;

/** The icon beside a file name: the one in the smallest box that holds the name and an icon. */
function iconBeside(area: Locator, filename: string): Locator {
  return area
    .locator(":scope *")
    .filter({ hasText: filename })
    .filter({ has: area.page().locator("[data-file-type]") })
    .last()
    .locator("[data-file-type]");
}

test("a file carries the icon of its type in the composer, above the message and in Resources", async ({
  page
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Add attachment" })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(`${file.name} of the attachment test`)
    }))
  );

  // The chip says the type in words and the size once the upload stands.
  const composer = page.locator("form").filter({ has: page.getByPlaceholder("Message") });
  for (const file of files) {
    const icon = iconBeside(composer, file.name);
    await expect(icon).toHaveAttribute("data-file-type", file.icon);
    // The name beside it says the same, so the icon is not read out.
    await expect(icon).toHaveAttribute("aria-hidden", "true");
  }
  await expect(composer.getByText(/^Spreadsheet · \d+ B$/u)).toBeVisible();
  await expect(composer.getByText(/^Word document · \d+ B$/u)).toBeVisible();

  await page.getByPlaceholder("Message").fill("Four files of four types");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/^Local agent response:/u)).toBeVisible();

  const message = page.locator('[data-role="user"]').last();
  for (const file of files) {
    await expect(iconBeside(message, file.name)).toHaveAttribute("data-file-type", file.icon);
  }

  // The panel opens by itself with the first file of a conversation.
  const resources = page.getByRole("complementary", { name: "Resources" });
  for (const file of files) {
    await expect(iconBeside(resources, file.name)).toHaveAttribute("data-file-type", file.icon);
  }
});

test("a file goes without text, picked on the start page and pasted in an open conversation", async ({
  page
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  const input = page.getByPlaceholder("Message");
  const send = page.getByRole("button", { name: "Send message" });
  await expect(send).toBeDisabled();

  await page.locator('input[type="file"]').setInputFiles({
    name: "picked.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A file sent alone")
  });
  await expect(send).toBeEnabled();
  await send.click();
  // The local agent repeats what it received: the file's line, so the file reached its turn.
  const received = (filename: string) =>
    page.getByRole("listitem").filter({ hasText: new RegExp(`^${filename} \\(fileId: `, "u") });
  await expect(received("picked.txt")).toBeVisible();
  await expect(page.locator('[data-role="user"]').last()).toContainText("picked.txt");
  await expect(send).toBeDisabled();

  // A pasted file uploads like a picked one, and Enter sends it once it is ready.
  await input.evaluate((field) => {
    const data = new DataTransfer();
    data.items.add(new File(["Pasted alone"], "pasted.txt", { type: "text/plain" }));
    field.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
    );
  });
  await expect(send).toBeEnabled();
  await input.press("Enter");
  await expect(received("pasted.txt")).toBeVisible();
  await expect(page.locator('[data-role="user"]').last()).toContainText("pasted.txt");
  await expect(page.getByText("A message needs text or an attachment.")).toHaveCount(0);
});
