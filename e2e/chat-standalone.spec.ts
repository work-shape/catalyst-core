import { expect, test, type Page } from "@playwright/test";

const apiBaseUrl = "http://127.0.0.1:4210";
const normalUser = {
  email: "e2e-user@example.test",
  password: "e2e-user-password"
};
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
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
  await expect(page.getByRole("button", { name: "Open superadmin panel" })).toHaveCount(0);

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
  await expect(page.getByText("Research Assistant is ready for this conversation.")).toBeVisible();

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
  let messageRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") {
      messageRequests += 1;
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
  expect(messageRequests).toBe(0);

  const messageResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat"
  );
  await input.press("Enter");
  await messageResponse;

  expect(messageRequests).toBe(1);
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
  await expect(page.getByRole("button", { name: "Add attachment" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Find review risks" })).toBeVisible();

  const input = page.getByPlaceholder("Message");
  await input.fill("Draft on the new screen");
  await newConversationButton.click();

  expect(createConversationRequests).toBe(0);
  await expect(input).toHaveValue("Draft on the new screen");
  await expect(input).toBeFocused();
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

test("conversation switching isolates pending stream state", async ({ page }) => {
  await signInViaApi(page, normalUser);
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
  await page.route(`${apiBaseUrl}/api/chat`, async (route) => {
    chatRequestStarted = true;
    await chatGate;
    await route.abort("aborted");
  });

  try {
    await page.goto("/");
    const input = page.getByPlaceholder("Message");
    const sourceConversation = page.getByTestId("conversation-row").filter({ hasText: sourceTitle });
    const targetConversation = page.getByTestId("conversation-row").filter({ hasText: targetTitle });
    await expect(sourceConversation).toHaveCount(1);
    await expect(targetConversation).toHaveCount(1);

    await sourceConversation.getByRole("button").first().click();
    const messageText = `Session isolation ${suffix}`;
    await input.fill(messageText);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByTestId("pending-assistant-message")).toBeVisible();
    await expect.poll(() => chatRequestStarted).toBe(true);
    await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

    await targetConversation.getByRole("button").first().click();
    await expect(page.getByText(messageText)).toHaveCount(0);
    await expect(page.getByTestId("pending-assistant-message")).toHaveCount(0);
    await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

    await sourceConversation.getByRole("button").first().click();
    await expect(page.getByTestId("pending-assistant-message")).toBeVisible();
  } finally {
    releaseChat();
    await page.unroute(`${apiBaseUrl}/api/chat`);
  }
});

test("new conversation stream completion does not steal the selected conversation", async ({ page }) => {
  await signInViaApi(page, normalUser);
  const suffix = Date.now();
  const targetTitle = `Switch target ${suffix}`;
  const target = await page.request.post(`${apiBaseUrl}/api/conversations`, {
    data: { title: targetTitle }
  });
  expect(target.ok()).toBe(true);

  let chatRequestStarted = false;
  let releaseChat: () => void = () => {};
  const chatGate = new Promise<void>((resolve) => {
    releaseChat = resolve;
  });
  await page.route(`${apiBaseUrl}/api/chat`, async (route) => {
    chatRequestStarted = true;
    await chatGate;
    await route.abort("aborted");
  });

  try {
    await page.goto("/");
    const input = page.getByPlaceholder("Message");
    const messageText = `New session isolation ${suffix}`;
    await input.fill(messageText);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByTestId("pending-assistant-message")).toBeVisible();
    await expect.poll(() => chatRequestStarted).toBe(true);
    const newConversation = page.getByTestId("conversation-row").filter({ hasText: messageText });
    await expect(newConversation.getByTestId("conversation-running-indicator")).toBeVisible();

    const targetConversation = page.getByTestId("conversation-row").filter({ hasText: targetTitle });
    await targetConversation.getByRole("button").first().click();
    releaseChat();
    await expect(targetConversation).toHaveClass(/border-primary/);
    await expect(page.getByText(messageText)).toHaveCount(0);
    await expect(page.getByTestId("pending-assistant-message")).toHaveCount(0);
  } finally {
    releaseChat();
    await page.unroute(`${apiBaseUrl}/api/chat`);
  }
});

test("completed background turns are marked unread until viewed", async ({ page }) => {
  await signInViaApi(page, normalUser);
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

  await page.goto("/");
  const input = page.getByPlaceholder("Message");
  const sourceConversation = page.getByTestId("conversation-row").filter({ hasText: sourceTitle });
  const targetConversation = page.getByTestId("conversation-row").filter({ hasText: targetTitle });
  await expect(sourceConversation).toHaveCount(1);
  await expect(targetConversation).toHaveCount(1);

  await sourceConversation.getByRole("button").first().click();
  await input.fill(`Unread completion ${suffix}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

  await targetConversation.getByRole("button").first().click();
  await expect(sourceConversation.getByTestId("conversation-unread-indicator")).toBeVisible({
    timeout: 20_000
  });
  await expect(sourceConversation.getByTestId("conversation-unread-label")).toBeVisible();

  await sourceConversation.getByRole("button").first().click();
  await expect(sourceConversation.getByTestId("conversation-unread-indicator")).toHaveCount(0);
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
  await expect(page.getByRole("button", { name: "Open superadmin panel" })).toBeVisible();

  await page.getByRole("button", { name: "E2E Superadmin account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
  await signInViaUi(page, normalUser, { alreadyOnLogin: true });
  await expect(page.getByRole("button", { name: "Open superadmin panel" })).toHaveCount(0);
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

  await page.getByRole("button", { name: "Open superadmin panel" }).click();
  await expect(page.getByRole("region", { name: "Superadmin panel" })).toBeVisible();
  await expectDocumentScrollLocked(page);
});

test("superadmin can open usage and audit views", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  await ensureDarkMode(page);
  await expect(page.getByRole("button", { name: "Open superadmin panel" })).toBeVisible();
  await page.getByRole("button", { name: "Open superadmin panel" }).click();
  await expect(page.getByRole("region", { name: "Superadmin panel" })).toBeVisible();
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

test("demo chat can run a configured tool widget", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  const forecastLocation = `Oslo ${Date.now()}`;
  const consoleErrors: string[] = [];
  let messageHistoryResponses = 0;
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
      /^\/api\/conversations\/[^/]+\/messages$/u.test(url.pathname)
    ) {
      messageHistoryResponses += 1;
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
  await expect(page.getByTestId("assistant-working-indicator")).toBeVisible();

  const toolCallCard = page.getByTestId("tool-call-card").last();
  await expect(toolCallCard).toBeVisible();
  await expect(toolCallCard).toContainText("demo.weather_forecast");
  await expect(toolCallCard).toContainText("Completed");
  await expect(toolCallCard).toContainText("Weather forecast");
  await expect(toolCallCard).toContainText(forecastLocation);
  await expect(toolCallCard).toContainText("3-day forecast");
  await expect(page.getByText("Tool work completed").last()).toBeVisible();
  await expect(page.getByText(`Forecast for ${forecastLocation}`).last()).toBeVisible();
  await expect(page.getByTestId("assistant-working-indicator")).toHaveCount(0);
  await expect.poll(() => messageHistoryResponses).toBeGreaterThan(0);
  await expect(toolCallCard).toBeVisible();
  await expect(toolCallCard).toContainText("Completed");

  await page.getByRole("button", { name: "Open superadmin panel" }).click();
  await expect(page.getByRole("region", { name: "Superadmin panel" })).toBeVisible();
  await expect(page.getByText("Administration")).toBeVisible();
  await expect(page.getByText("Budgeted cost today")).toBeVisible();
  await expect(page.getByText("Calls today")).toBeVisible();
  await expect(page.getByText("Configured pricing")).toBeVisible();
  await expect(page.getByText("local / deterministic-local")).toBeVisible();
  await expect(page.getByText("Configured safeguards")).toBeVisible();
  const configuredSafeguards = page.getByTestId("configured-safeguards");
  await expect(configuredSafeguards).toContainText("12");
  await expect(configuredSafeguards).toContainText("25,000");
  await expect(page.getByText("Recent model usage")).toBeVisible();
  await expect(page.getByText("deterministic-local").first()).toBeVisible();
  await expect(page.getByText("not_reported").first()).toBeVisible();
  await page.getByRole("button", { name: "Audit log" }).click();
  await expect(page.getByText("Recent audit events")).toBeVisible();
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
  await page.getByRole("button", { name: "Open superadmin panel" }).click();
  await expect(page.getByRole("region", { name: "Superadmin panel" })).toBeVisible();

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
