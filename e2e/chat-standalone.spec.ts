import { expect, test, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const normalUser = {
  email: "e2e-user@example.test",
  password: "e2e-user-password"
};
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const adminUser = {
  email: "e2e-admin@example.test",
  password: "e2e-admin-password"
};

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
  await expect(page.getByRole("button", { name: "Select agent" })).toContainText("Application Assistant");
  await expect(page.getByRole("button", { name: "Close sidebar" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Switch to (dark|light) theme/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Language" })).toHaveCount(0);
  await expect(page.locator("header").getByText("Ready", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open administration panel" })).toHaveCount(0);

  await page.getByRole("button", { name: "E2E User account" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("region", { name: "User settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Language" })).toBeVisible();
});

test("floating chrome toggles sidebar, agent, and theme", async ({ page }) => {
  await signInViaUi(page, normalUser);
  await page.goto("/");

  await page.getByRole("button", { name: "Close sidebar" }).click();
  await expect(page.getByText("E2E Customer")).toBeHidden();
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(page.getByText("E2E Customer")).toBeVisible();

  await page.getByRole("button", { name: "Select agent" }).click();
  await expect(page.getByRole("option", { name: /Research Assistant/ })).toBeVisible();
  await page.getByRole("option", { name: /Research Assistant/ }).click();
  await expect(page.getByRole("button", { name: "Select agent" })).toContainText("Research Assistant");

  const appShell = page.locator("main").first();
  const backgroundBefore = await appShell.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--background")
  );
  await page.getByRole("button", { name: /Switch to (dark|light) theme/ }).click();
  await expect
    .poll(() =>
      appShell.evaluate((element) => getComputedStyle(element).getPropertyValue("--background"))
    )
    .not.toBe(backgroundBefore);
});

test("composer grows for multiline input", async ({ page }) => {
  await signInViaUi(page, normalUser);
  await page.goto("/");

  const input = page.getByPlaceholder("Message");
  await expect(input).toBeVisible();
  const initialHeight = await input.evaluate((element) => element.getBoundingClientRect().height);

  await input.fill("Line one\nLine two\nLine three");

  await expect
    .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(initialHeight);
});

test("composer sends on Enter and inserts a newline on Shift+Enter", async ({ page }) => {
  await signInViaUi(page, normalUser);
  let createRunRequests = 0;
  let legacyChatRequests = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/conversations/runs") {
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
      new URL(response.url()).pathname === "/api/conversations/runs"
  );
  await input.press("Enter");
  await createRunResponse;

  expect(createRunRequests).toBe(1);
  expect(legacyChatRequests).toBe(0);
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);
  await expect(input).toHaveValue("");
});

test("new conversation action opens an unsaved draft screen", async ({ page }) => {
  await signInViaUi(page, normalUser);
  let createConversationRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/conversations") {
      createConversationRequests += 1;
    }
  });

  await page.goto("/");
  const newConversationButton = page.getByRole("button", { name: "New", exact: true });
  await expect(newConversationButton).toBeVisible();
  await expect(page.getByRole("button", { name: "Select agent" })).toContainText("Application Assistant");
  await expect(page.getByRole("button", { name: "Add attachment" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Find review risks" })).toBeVisible();

  const input = page.getByPlaceholder("Message");
  await input.fill("Draft on the new screen");
  await newConversationButton.click();

  expect(createConversationRequests).toBe(0);
  await expect(input).toHaveValue("Draft on the new screen");
  await expect(input).toBeFocused();
});

test("new conversation action returns from a persisted conversation to a clean draft route", async ({ page }) => {
  await signInViaUi(page, normalUser);
  await page.goto("/");
  const input = page.getByPlaceholder("Message");
  const messageText = `New action route reset ${Date.now()}`;

  await input.fill(messageText);
  const createRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/conversations/runs"
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await createRunResponse;
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);

  const conversationId = currentConversationId(page);
  const createdConversation = page.getByTestId("conversation-row").filter({ hasText: messageText });
  await expect(createdConversation).toHaveCount(1);
  await expect(createdConversation).toHaveClass(/border-primary/);

  await page.getByRole("button", { name: "New", exact: true }).click();

  await expect(page).toHaveURL(/\/$/u);
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(createdConversation).toHaveCount(1);

  await createdConversation.getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(conversationPath(conversationId))}$`, "u"));
});

test("standalone conversation routes are addressable and follow rail navigation", async ({ page }) => {
  await signInViaApi(page, normalUser);
  const title = `Route target ${Date.now()}`;
  const created = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title }
  });
  expect(created.ok()).toBe(true);
  const conversation = (await created.json()) as { id: string };

  await page.goto(conversationPath(conversation.id));
  const input = page.getByPlaceholder("Message");
  const targetConversation = page.getByTestId("conversation-row").filter({ hasText: title });
  await expect(input).toBeVisible();
  await expect(targetConversation).toHaveClass(/border-primary/);
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(conversationPath(conversation.id))}$`));

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
  await input.fill("Route-scoped new draft");

  await targetConversation.getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(conversationPath(conversation.id))}$`));
  await expect(input).toHaveValue("");

  await page.goBack();
  await expect(page).toHaveURL(/\/$/u);
  await expect(input).toHaveValue("Route-scoped new draft");
});

test("first message from the root route moves to the persisted conversation route", async ({ page }) => {
  await signInViaUi(page, normalUser);
  await expect(page).toHaveURL(/\/$/u);
  let legacyChatRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") {
      legacyChatRequests += 1;
    }
  });

  const messageText = `Route creation ${Date.now()}`;
  const createRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/conversations/runs"
  );
  await page.getByPlaceholder("Message").fill(messageText);
  await page.getByRole("button", { name: "Send message" }).click();
  const response = await createRunResponse;
  expect(response.ok()).toBe(true);
  const started = (await response.json()) as { conversation: { id: string } };

  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(conversationPath(started.conversation.id))}$`, "u"));
  expect(legacyChatRequests).toBe(0);
  const createdConversation = page.getByTestId("conversation-row").filter({ hasText: messageText });
  await expect(createdConversation).toHaveClass(/border-primary/);

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByPlaceholder("Message")).toHaveValue("");
  await expect(createdConversation).toHaveCount(1);
});

test("root submit stays draft-only while create-run is pending", async ({ page }) => {
  await signInViaUi(page, normalUser);
  await expect(page).toHaveURL(/\/$/u);

  let releaseCreateRun = () => {};
  const createRunGate = new Promise<void>((resolve) => {
    releaseCreateRun = resolve;
  });
  let createRunRequests = 0;
  let legacyChatRequests = 0;
  await page.route(`${apiBaseUrl}/api/conversations/runs`, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    createRunRequests += 1;
    await createRunGate;
    await route.continue();
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") {
      legacyChatRequests += 1;
    }
  });

  const input = page.getByPlaceholder("Message");
  const chatRegion = page.getByRole("region", { name: "Chat" });
  const messageText = `Delayed route creation ${Date.now()}`;
  await input.fill(messageText);
  const createRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/conversations/runs"
  );
  await page.getByRole("button", { name: "Send message" }).click();

  await expect.poll(() => createRunRequests).toBe(1);
  await expect(page).toHaveURL(/\/$/u);
  await expect(input).toHaveValue(messageText);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(chatRegion.locator('[data-role="user"]').filter({ hasText: messageText })).toHaveCount(0);
  await expect(page.getByTestId("pending-assistant-message")).toHaveCount(0);
  await expect(page.getByTestId("assistant-cursor")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
  expect(legacyChatRequests).toBe(0);

  releaseCreateRun();
  const response = await createRunResponse;
  expect(response.ok()).toBe(true);
  const started = (await response.json()) as { conversation: { id: string } };

  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(conversationPath(started.conversation.id))}$`, "u"));
  await expect(input).toHaveValue("");
  await expect(chatRegion.locator('[data-role="user"]').filter({ hasText: messageText })).toHaveCount(1);
  expect(createRunRequests).toBe(1);
  expect(legacyChatRequests).toBe(0);
});

test("stop generating cancels the active stream instead of only hiding the button", async ({ page }) => {
  await signInViaUi(page, normalUser);

  await page.goto("/");
  const suffix = Date.now();
  const input = page.getByPlaceholder("Message");
  const messageTokens = Array.from({ length: 240 }, (_, index) => `stop-token-${suffix}-${index}`);
  const lateToken = messageTokens.at(-1) ?? "";
  const messageText = messageTokens.join(" ");
  expect(lateToken).not.toBe("");
  await input.fill(messageText);
  await input.press("Enter");
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);

  const stopButton = page.getByRole("button", { name: "Stop generating" });
  await expect(stopButton).toBeVisible();
  await expect(stopButton).toBeEnabled();
  await stopButton.click({ timeout: 5_000 });

  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 10_000 });
  await expect(stopButton).toHaveCount(0);
  await page.waitForTimeout(6_000);

  await expect(page.locator('[data-role="assistant"]').filter({ hasText: lateToken })).toHaveCount(0);

  const conversationId = currentConversationId(page);
  const messages = await page.request.get(`${apiBaseUrl}/api/conversations/${conversationId}/messages`);
  expect(messages.ok()).toBe(true);
  const persistedMessages = (await messages.json()) as Array<{ role: string; text: string }>;
  const persistedAssistantText = persistedMessages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");
  expect(persistedAssistantText).not.toContain(lateToken);
});

test("composer drafts are scoped to the new screen and selected conversations", async ({ page }) => {
  await signInViaApi(page, normalUser);
  const title = `Draft target ${Date.now()}`;
  const created = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title }
  });
  expect(created.ok()).toBe(true);

  await page.goto("/");
  const input = page.getByPlaceholder("Message");
  await input.fill("New screen draft");

  const targetConversation = page.getByTestId("conversation-row").filter({ hasText: title });
  await expect(targetConversation).toHaveCount(1);
  await targetConversation.getByRole("button").first().click();
  await expect(input).toHaveValue("");
  await input.fill("Selected conversation draft");

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(input).toHaveValue("New screen draft");

  await targetConversation.getByRole("button").first().click();
  await expect(input).toHaveValue("Selected conversation draft");
});

test("conversation switching isolates pending stream state", { tag: "@chat-state" }, async ({ page }) => {
  await signInViaUi(page, normalUser);
  const suffix = Date.now();
  const sourceTitle = `Streaming source ${suffix}`;
  const targetTitle = `Stable target ${suffix}`;
  const source = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title: sourceTitle }
  });
  const target = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title: targetTitle }
  });
  expect(source.ok()).toBe(true);
  expect(target.ok()).toBe(true);

  let chatRequestStarted = false;
  let releaseChat: () => void = () => {};
  const chatGate = new Promise<void>((resolve) => {
    releaseChat = resolve;
  });
  const runStartRoute = new RegExp(`${escapeRegExp(apiBaseUrl)}/api/conversations/[^/]+/runs$`, "u");
  await page.route(runStartRoute, async (route) => {
    chatRequestStarted = true;
    await chatGate;
    await route.abort("aborted").catch(() => undefined);
  });

  try {
    await page.goto("/");
    const input = page.getByPlaceholder("Message");
    const chatRegion = page.getByRole("region", { name: "Chat" });
    const sourceConversation = page.getByTestId("conversation-row").filter({ hasText: sourceTitle });
    const targetConversation = page.getByTestId("conversation-row").filter({ hasText: targetTitle });
    await expect(sourceConversation).toHaveCount(1);
    await expect(targetConversation).toHaveCount(1);

    await sourceConversation.getByRole("button").first().click();
    const sendButton = page.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled();
    const messageText = `Session isolation ${suffix}`;
    await input.fill(messageText);
    await sendButton.click();
    await expect(chatRegion.getByText(messageText)).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
    await expect.poll(() => chatRequestStarted).toBe(true);
    await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

    await targetConversation.getByRole("button").first().click();
    await expect(chatRegion.getByText(messageText)).toHaveCount(0);
    await expect(page.getByTestId("pending-assistant-message")).toHaveCount(0);
    await expect(page.getByTestId("assistant-cursor")).toHaveCount(0);
    await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

    await sourceConversation.getByRole("button").first().click();
    await expect(page.getByTestId("assistant-cursor")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  } finally {
    releaseChat();
    await page.unroute(runStartRoute);
  }
});

test("switching back to a running conversation resumes one stream indicator", { tag: "@chat-state" }, async ({ page }) => {
  await signInViaUi(page, normalUser);
  const suffix = Date.now();
  const sourceTitle = `Resume source ${suffix}`;
  const targetTitle = `Resume target ${suffix}`;
  const source = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title: sourceTitle }
  });
  const target = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title: targetTitle }
  });
  expect(source.ok()).toBe(true);
  expect(target.ok()).toBe(true);

  const eventRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && isRunEventsPath(url.pathname)) {
      eventRequests.push(request.url());
    }
  });

  await page.goto("/");
  const input = page.getByPlaceholder("Message");
  const chatRegion = page.getByRole("region", { name: "Chat" });
  const sourceConversation = page.getByTestId("conversation-row").filter({ hasText: sourceTitle });
  const targetConversation = page.getByTestId("conversation-row").filter({ hasText: targetTitle });
  await expect(sourceConversation).toHaveCount(1);
  await expect(targetConversation).toHaveCount(1);

  await sourceConversation.getByRole("button").first().click();
  const uniqueToken = `resume-token-${suffix}`;
  await input.fill(
    Array.from({ length: 90 }, (_, index) => `${uniqueToken}-${index}`).join(" ")
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();
  expect(await sampleMaxCursorCount(page, 300)).toBeLessThanOrEqual(1);

  await targetConversation.getByRole("button").first().click();
  await expect(chatRegion.getByText(uniqueToken)).toHaveCount(0);

  await sourceConversation.getByRole("button").first().click();
  await expect.poll(() => eventRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(chatRegion.getByText(uniqueToken, { exact: false }).first()).toBeVisible({
    timeout: 15_000
  });
  expect(await sampleMaxCursorCount(page, 1_000)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("pending-assistant-message")).toHaveCount(0);
  await stopActiveRun(page);
});

test("direct conversation links resume a running stream from stored state", { tag: "@chat-state" }, async ({ page }) => {
  await signInViaUi(page, normalUser);
  const suffix = Date.now();
  const sourceTitle = `Direct resume source ${suffix}`;
  const source = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title: sourceTitle }
  });
  expect(source.ok()).toBe(true);
  const conversation = (await source.json()) as { id: string };

  const eventRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && isRunEventsPath(url.pathname)) {
      eventRequests.push(request.url());
    }
  });

  await page.goto(conversationPath(conversation.id));
  const input = page.getByPlaceholder("Message");
  const chatRegion = page.getByRole("region", { name: "Chat" });
  const sourceConversation = page.getByTestId("conversation-row").filter({ hasText: sourceTitle });
  await expect(sourceConversation).toHaveCount(1);

  const uniqueToken = `direct-resume-token-${suffix}`;
  await input.fill(Array.from({ length: 100 }, (_, index) => `${uniqueToken}-${index}`).join(" "));
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

  await page.goto(conversationPath(conversation.id));
  const runningConversation = page.getByTestId("conversation-row").filter({
    has: page.getByTestId("conversation-running-indicator")
  });
  await expect(runningConversation).toHaveCount(1);
  await expect(runningConversation).toHaveClass(/border-primary/);
  await expect.poll(() => eventRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(chatRegion.locator('[data-role="assistant"]').filter({ hasText: uniqueToken }).first()).toBeVisible({
    timeout: 15_000
  });
  await expect(page.getByTestId("pending-assistant-message")).toHaveCount(0);
  await stopActiveRun(page);
});

test("new conversation run completion does not steal the selected conversation", { tag: "@chat-state" }, async ({ page }) => {
  await signInViaUi(page, normalUser);
  const suffix = Date.now();
  const targetTitle = `Switch target ${suffix}`;
  const target = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title: targetTitle }
  });
  expect(target.ok()).toBe(true);

  await page.goto("/");
  const input = page.getByPlaceholder("Message");
  const chatRegion = page.getByRole("region", { name: "Chat" });
  const sendButton = page.getByRole("button", { name: "Send message" });
  await expect(sendButton).toBeEnabled();
  const messageToken = `new-run-isolation-${suffix}`;
  const messageText = Array.from({ length: 120 }, (_, index) => `${messageToken}-${index}`).join(" ");
  await input.fill(messageText);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/conversations/runs"
    ),
    sendButton.click()
  ]);
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  expect(await sampleMaxCursorCount(page, 300)).toBeLessThanOrEqual(1);
  const newConversation = page.getByTestId("conversation-row").filter({ hasText: messageToken });
  await expect(newConversation.getByTestId("conversation-running-indicator")).toBeVisible();

  const targetConversation = page.getByTestId("conversation-row").filter({ hasText: targetTitle });
  await targetConversation.getByRole("button").first().click();
  await expect(targetConversation).toHaveClass(/border-primary/);
  await expect(chatRegion.getByText(messageToken, { exact: false })).toHaveCount(0);
  await expect(page.getByTestId("pending-assistant-message")).toHaveCount(0);
  await page.waitForTimeout(1_000);
  await expect(targetConversation).toHaveClass(/border-primary/);
});

test("completed background turns are marked unread until viewed", { tag: "@chat-state" }, async ({ page }) => {
  await signInViaUi(page, normalUser);
  const suffix = Date.now();
  const sourceTitle = `Unread source ${suffix}`;
  const targetTitle = `Unread target ${suffix}`;
  const source = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title: sourceTitle }
  });
  const target = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title: targetTitle }
  });
  expect(source.ok()).toBe(true);
  expect(target.ok()).toBe(true);

  const eventRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && isRunEventsPath(url.pathname)) {
      eventRequests.push(request.url());
    }
  });

  await page.goto("/");
  const input = page.getByPlaceholder("Message");
  const chatRegion = page.getByRole("region", { name: "Chat" });
  const sourceConversation = page.getByTestId("conversation-row").filter({ hasText: sourceTitle });
  const targetConversation = page.getByTestId("conversation-row").filter({ hasText: targetTitle });
  await expect(sourceConversation).toHaveCount(1);
  await expect(targetConversation).toHaveCount(1);

  await sourceConversation.getByRole("button").first().click();
  const sendButton = page.getByRole("button", { name: "Send message" });
  await expect(sendButton).toBeEnabled();
  const forecastLocation = `Unread background ${suffix}`;
  await input.fill(
    `/tool demo.weather_forecast {"location":"${forecastLocation}","days":3,"unit":"celsius","startDate":"2026-06-13"}`
  );
  await sendButton.click();
  await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

  await targetConversation.getByRole("button").first().click();
  await expect(sourceConversation.getByTestId("conversation-unread-indicator")).toBeVisible({
    timeout: 20_000
  });
  await expect(sourceConversation.getByTestId("conversation-unread-label")).toBeVisible();

  const eventRequestCountBeforeView = eventRequests.length;
  await sourceConversation.getByRole("button").first().click();
  await page.waitForTimeout(500);
  expect(eventRequests).toHaveLength(eventRequestCountBeforeView);
  await expect(sourceConversation.getByTestId("conversation-unread-indicator")).toHaveCount(0);
  await expect(page.getByTestId("pending-assistant-message")).toHaveCount(0);
  await expect(page.getByTestId("assistant-cursor")).toHaveCount(0);
  const workGroupTrigger = chatRegion.getByTestId("assistant-work-group-trigger").last();
  await expect(workGroupTrigger).toBeVisible();
  await workGroupTrigger.click();
  const toolCallCard = chatRegion.getByTestId("tool-call-card").last();
  await expect(toolCallCard).toBeVisible();
  await expect(toolCallCard).toContainText("Completed");
  await expect(toolCallCard).toContainText(forecastLocation);
  await expect(chatRegion.getByText("Tool work completed")).toHaveCount(1);
});

test("conversation rail deletes a conversation", async ({ page }) => {
  await signInViaApi(page, normalUser);
  let deleteConversationRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && /^\/api\/conversations\/[^/]+$/u.test(new URL(request.url()).pathname)) {
      deleteConversationRequests += 1;
    }
  });

  const title = `Delete target ${Date.now()}`;
  const created = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title }
  });
  expect(created.ok()).toBe(true);

  await page.goto("/");
  const conversations = page.getByTestId("conversation-row");
  const targetConversation = conversations.filter({ hasText: title });
  await expect(targetConversation).toHaveCount(1);

  const conversationCountBefore = await conversations.count();
  const optionsButton = targetConversation.getByRole("button", {
    name: `Conversation options for ${title}`,
    exact: true
  });
  await expect(optionsButton).toBeVisible();
  await optionsButton.click();
  await page.getByRole("menuitem", { name: "Delete conversation", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Delete conversation?", exact: true })).toBeVisible();
  expect(deleteConversationRequests).toBe(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Delete conversation?", exact: true })).toHaveCount(0);

  await optionsButton.click();
  await page.getByRole("menuitem", { name: "Delete conversation", exact: true }).click();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        /^\/api\/conversations\/[^/]+$/u.test(new URL(response.url()).pathname)
    ),
    page.getByRole("button", { name: "Delete", exact: true }).click()
  ]);

  expect(deleteConversationRequests).toBe(1);
  await expect(targetConversation).toHaveCount(0);
  await expect(conversations).toHaveCount(conversationCountBefore - 1);
});

test("standalone auth gates superadmin views", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  await expect(page.getByRole("button", { name: "Usage" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open administration panel" })).toBeVisible();

  await page.getByRole("button", { name: "E2E Superadmin account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
  await signInViaUi(page, normalUser, { alreadyOnLogin: true });
  await expect(page.getByRole("button", { name: "Open administration panel" })).toHaveCount(0);
});

test("standalone settings and superadmin tabs are route-backed", async ({ page }) => {
  await signInViaApi(page, superadminUser);

  await page.goto("/settings");
  await expect(page.getByRole("region", { name: "User settings" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/u);

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/usage$/u);
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();
  await expect(page.getByText("Billed this month")).toBeVisible();

  await page.getByRole("button", { name: /^Users/ }).click();
  await expect(page).toHaveURL(/\/admin\/users$/u);
  await expect(
    page.getByRole("region", { name: "Administration panel" }).getByRole("heading", { name: "Users" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Audit log" }).click();
  await expect(page).toHaveURL(/\/admin\/audit$/u);
  await expect(page.getByText("Recent activity")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/users$/u);
  await expect(
    page.getByRole("region", { name: "Administration panel" }).getByRole("heading", { name: "Users" })
  ).toBeVisible();
});

test("normal users are redirected away from superadmin routes", async ({ page }) => {
  await signInViaApi(page, normalUser);

  await page.goto("/admin/usage");

  await expect(page.getByText("E2E Customer")).toBeVisible();
  await expect(page.getByRole("region", { name: "Administration panel" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/u);
});

test("workspace and superadmin keep page scroll locked", async ({ page }) => {
  await signInViaApi(page, superadminUser);
  for (let index = 0; index < 18; index += 1) {
    const created = await page.request.post(`${apiBaseUrl}/api/conversations`, {
      data: { title: `Scroll lock target ${Date.now()} ${index}` }
    });
    expect(created.ok()).toBe(true);
  }

  await page.goto("/");
  await expect(page.getByText("E2E Customer")).toBeVisible();
  await expectDocumentScrollLocked(page);

  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();
  await expectDocumentScrollLocked(page);
});

test("superadmin can open usage and audit views", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  await ensureDarkMode(page);
  await expect(page.getByRole("button", { name: "Open administration panel" })).toBeVisible();
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();
  await expect(page.getByText("Administration")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Usage/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Users/ })).toBeVisible();
  await page.getByRole("button", { name: /^Users/ }).click();
  await expect
    .poll(() =>
      page
        .getByLabel("Filter by status")
        .evaluate((element) => getComputedStyle(element).backgroundColor)
    )
    .not.toBe("rgb(255, 255, 255)");
  await expect(page.getByRole("button", { name: "Audit log" })).toBeVisible();
});

test("admin sees billed usage and can manage users", async ({ page }) => {
  await signInViaUi(page, adminUser);
  await expect(page.getByRole("button", { name: "Open administration panel" })).toBeVisible();
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page).toHaveURL(/\/admin\/usage$/u);
  const adminPanel = page.getByRole("region", { name: "Administration panel" });
  await expect(adminPanel).toBeVisible();
  await expect(adminPanel.getByText("Admin", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Usage/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Users/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Audit log" })).toBeVisible();
  await expect(page.getByText("Billed this month")).toBeVisible();
  await expect(page.getByTestId("monthly-usage")).toBeVisible();

  await page.getByRole("button", { name: /^Users/ }).click();
  await expect(page).toHaveURL(/\/admin\/users$/u);
  await page.getByRole("button", { name: "New user" }).click();
  const timestamp = Date.now();
  const createdUser = {
    displayLabel: `E2E Admin Created ${timestamp}`,
    email: `e2e-admin-created-${timestamp}@example.test`,
    password: `e2e-admin-created-${timestamp}`
  };
  const dialog = page.getByRole("dialog", { name: "New user" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Access level").locator("option[value=\"superadmin\"]")).toHaveCount(0);
  await dialog.getByLabel("Display label").fill(createdUser.displayLabel);
  await dialog.getByLabel("Email").fill(createdUser.email);
  await dialog.getByLabel("Initial password").fill(createdUser.password);
  await dialog.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("dialog", { name: "User created" })).toBeVisible();
  await page.getByRole("button", { name: "Open user" }).click();
  await expect(page.getByText(createdUser.displayLabel, { exact: true })).toBeVisible();
});

test("demo chat can run a configured tool widget", async ({ page }) => {
  await signInViaUi(page, superadminUser);
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
      /^\/api\/conversations\/[^/]+\/(?:messages|thread)$/u.test(url.pathname)
    ) {
      historyResponses += 1;
    }
  });

  await page.goto("/");
  await expect(page.getByText("E2E Customer")).toBeVisible();
  await page
    .getByPlaceholder("Message")
    .fill(
      `/tool demo.weather_forecast {"location":"${forecastLocation}","days":3,"unit":"celsius","startDate":"2026-06-13"}`
    );
  await page.getByRole("button", { name: "Send message" }).click();

  const toolCallCard = page.getByTestId("tool-call-card").last();
  const workGroupTrigger = page.getByTestId("assistant-work-group-trigger").last();
  await expect(workGroupTrigger).toBeVisible();
  await workGroupTrigger.click();
  await expect(toolCallCard).toBeVisible();
  await expect(toolCallCard).toContainText("Weather Forecast");
  await expect(toolCallCard).toContainText("Completed");
  await expect(toolCallCard).toContainText("Weather forecast");
  await expect(toolCallCard).toContainText(forecastLocation);
  await expect(toolCallCard).toContainText("3-day forecast");
  await expect(page.getByText("Tool work completed").last()).toBeVisible();
  await expect(page.getByTestId("pending-assistant-message")).toHaveCount(0);
  await expect.poll(() => historyResponses).toBeGreaterThan(0);
  await expect(toolCallCard).toBeVisible();
  await expect(toolCallCard).toContainText("Completed");

  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();
  await expect(page.getByText("Administration")).toBeVisible();
  await expect(page.getByText("Billed this month")).toBeVisible();
  await expect(page.getByText("Billed today")).toBeVisible();
  await expect(page.getByTestId("daily-usage")).toBeVisible();
  await expect(page.getByTestId("monthly-usage")).toBeVisible();
  await expect(page.getByText("Configured safeguards")).toBeVisible();
  const configuredSafeguards = page.getByTestId("configured-safeguards");
  await expect(configuredSafeguards).toContainText("12");
  await expect(configuredSafeguards).toContainText("25,000");
  await expect(page.getByText("Recent model usage")).toBeVisible();
  await expect(page.getByText("deterministic-local").first()).toBeVisible();
  await expect(page.getByText("not_reported").first()).toBeVisible();
  await page.getByRole("button", { name: "Audit log" }).click();
  await expect(page.getByText("Recent activity")).toBeVisible();
  // Tool runs are folded into their activity as evidence; expand the rows to reveal them.
  const adminRegion = page.getByRole("region", { name: "Administration panel" });
  const activityRows = adminRegion.locator("button[aria-expanded]");
  const rowCount = await activityRows.count();
  for (let index = 0; index < rowCount; index += 1) {
    await activityRows.nth(index).click();
  }
  await expect(page.getByText("tool.completed").first()).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("superadmin resets a user's password from the users panel", async ({ page }) => {
  // Make sure the normal user exists in the platform user store before administering it.
  await signInViaApi(page, normalUser);
  const normalMe = await page.request.get(`${apiBaseUrl}/api/me`);
  expect(normalMe.ok()).toBe(true);
  await page.request.post(`${apiBaseUrl}/api/auth/sign-out`, { data: {} });
  await page.context().clearCookies();

  await signInViaUi(page, superadminUser);
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();

  await page.getByRole("button", { name: /^Users/ }).click();
  await page.getByRole("button", { name: `E2E User ${normalUser.email}` }).click();
  await expect(page.getByText("Sign-in identities")).toBeVisible();

  const temporaryPassword = `e2e-reset-${Date.now()}`;
  await page.getByLabel("New password").fill(temporaryPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Password updated", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "E2E Superadmin account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();

  await signInViaUi(
    page,
    { email: normalUser.email, password: temporaryPassword },
    { alreadyOnLogin: true }
  );
  await expect(page.getByText("E2E User")).toBeVisible();

  // Restore the seeded password so reruns against a reused server stay consistent.
  await page.request.post(`${apiBaseUrl}/api/auth/sign-out`, { data: {} });
  await page.context().clearCookies();
  await signInViaApi(page, superadminUser);
  const usersResponse = await page.request.get(`${apiBaseUrl}/api/superadmin/users`);
  expect(usersResponse.ok()).toBe(true);
  const administeredUsers = (await usersResponse.json()) as Array<{ id: string; email?: string }>;
  const target = administeredUsers.find((candidate) => candidate.email === normalUser.email);
  expect(target).toBeDefined();
  const restored = await page.request.post(
    `${apiBaseUrl}/api/superadmin/users/${target?.id}/password`,
    { data: { password: normalUser.password } }
  );
  expect(restored.ok()).toBe(true);
});

test("superadmin creates a user with a password from the users panel", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();

  await page.getByRole("button", { name: /^Users/ }).click();
  await page.getByRole("button", { name: "New user" }).click();

  const timestamp = Date.now();
  const createdUser = {
    displayLabel: `E2E Created ${timestamp}`,
    email: `e2e-created-${timestamp}@example.test`,
    password: `e2e-created-${timestamp}`
  };
  const dialog = page.getByRole("dialog", { name: "New user" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Display label").fill(createdUser.displayLabel);
  await dialog.getByLabel("Email").fill(createdUser.email);
  const initialPasswordInput = dialog.getByLabel("Initial password");
  await expect(initialPasswordInput).toHaveAttribute("type", "password");
  await initialPasswordInput.fill(createdUser.password);
  await dialog.getByRole("button", { name: "Show password" }).click();
  await expect(initialPasswordInput).toHaveAttribute("type", "text");
  await expect(initialPasswordInput).toHaveValue(createdUser.password);
  await dialog.getByRole("button", { name: "Hide password" }).click();
  await expect(initialPasswordInput).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Create user" }).click();
  const createdDialog = page.getByRole("dialog", { name: "User created" });
  await expect(createdDialog).toBeVisible();
  const createdPasswordInput = createdDialog.getByLabel("Initial password");
  await expect(createdPasswordInput).toHaveAttribute("type", "password");
  await createdDialog.getByRole("button", { name: "Show password" }).click();
  await expect(createdPasswordInput).toHaveAttribute("type", "text");
  await expect(createdPasswordInput).toHaveValue(createdUser.password);
  await page.getByRole("button", { name: "Open user" }).click();
  await expect(page.getByText(createdUser.displayLabel, { exact: true })).toBeVisible();
  await expect(page.getByText("better-auth")).toBeVisible();

  await page.getByRole("button", { name: "E2E Superadmin account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();

  await signInViaUi(
    page,
    { email: createdUser.email, password: createdUser.password },
    { alreadyOnLogin: true }
  );
  await expect(page.getByRole("button", { name: `${createdUser.displayLabel} account` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open administration panel" })).toHaveCount(0);
});

test("superadmin deletes a user from the users panel", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();

  await page.getByRole("button", { name: /^Users/ }).click();
  await page.getByRole("button", { name: "New user" }).click();

  const timestamp = Date.now();
  const createdUser = {
    displayLabel: `E2E Deleted ${timestamp}`,
    email: `e2e-deleted-${timestamp}@example.test`,
    password: `e2e-deleted-${timestamp}`
  };
  const dialog = page.getByRole("dialog", { name: "New user" });
  await dialog.getByLabel("Display label").fill(createdUser.displayLabel);
  await dialog.getByLabel("Email").fill(createdUser.email);
  await dialog.getByLabel("Initial password").fill(createdUser.password);
  await dialog.getByRole("button", { name: "Create user" }).click();
  await page.getByRole("button", { name: "Open user" }).click();
  await expect(page.getByText(createdUser.displayLabel, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Delete user" }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Delete user" }).click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByText(createdUser.displayLabel, { exact: true })).toHaveCount(0);

  const usersResponse = await page.request.get(`${apiBaseUrl}/api/superadmin/users`);
  expect(usersResponse.ok()).toBe(true);
  const users = (await usersResponse.json()) as Array<{ email?: string }>;
  expect(users.some((user) => user.email === createdUser.email)).toBe(false);
});

function conversationPath(conversationId: string): string {
  return `/c/${encodeURIComponent(conversationId)}`;
}

function isRunEventsPath(pathname: string): boolean {
  return /^\/api\/conversations\/[^/]+\/runs\/[^/]+\/events$/u.test(pathname);
}

function currentConversationId(page: Page): string {
  const match = /^\/c\/([^/]+)$/u.exec(new URL(page.url()).pathname);
  if (!match?.[1]) {
    throw new Error(`Current route is not a conversation route: ${page.url()}`);
  }
  return decodeURIComponent(match[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function signInViaUi(
  page: Page,
  user: { email: string; password: string },
  options: { alreadyOnLogin?: boolean } = {}
): Promise<void> {
  if (!options.alreadyOnLogin) {
    await page.goto("/");
  }
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/auth/sign-in/email"
    ),
    page.getByRole("button", { name: "Sign in", exact: true }).click()
  ]);
  await expect(page.getByText("E2E Customer")).toBeVisible();
}

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page.request.post(`${apiBaseUrl}/api/auth/sign-in/email`, {
    data: {
      email: user.email,
      password: user.password,
      rememberMe: true
    }
  });
  expect(response.ok()).toBe(true);
}

async function ensureDarkMode(page: Page): Promise<void> {
  const isDark = await page.locator("main").first().evaluate((element) => element.classList.contains("dark"));
  if (!isDark) {
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
  }
  await expect.poll(() => page.locator("main").first().evaluate((element) => element.classList.contains("dark"))).toBe(true);
}

async function sampleMaxCursorCount(page: Page, durationMs: number): Promise<number> {
  const deadline = Date.now() + durationMs;
  let maxCount = 0;
  while (Date.now() < deadline) {
    maxCount = Math.max(maxCount, await page.getByTestId("assistant-cursor").count());
    await page.waitForTimeout(50);
  }
  return maxCount;
}

async function stopActiveRun(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop generating" });
  if ((await stopButton.count()) === 0) {
    return;
  }
  await stopButton.click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 10_000 });
}

async function expectDocumentScrollLocked(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement;
        return {
          clientHeight: root.clientHeight,
          scrollHeight: root.scrollHeight,
          bodyOverflow: getComputedStyle(document.body).overflow
        };
      })
    )
    .toEqual(
      expect.objectContaining({
        bodyOverflow: "hidden"
      })
    );
  const dimensions = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return {
      clientHeight: root.clientHeight,
      scrollHeight: root.scrollHeight
    };
  });
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.clientHeight + 1);
}
