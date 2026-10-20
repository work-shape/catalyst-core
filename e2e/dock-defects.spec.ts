import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { requestAnswered } from "./allowed-page-errors";
// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: [
    {
      name: "dock-thread-rate-limited",
      reason:
        "Chromium's own log line: the test answers the dock's thread once with 429 and asserts " +
        "that it is asked for again.",
      matches: requestAnswered(429),
      path: /^\/api\/v1\/conversations\/[^/]+\/thread$/u,
      tests: ["a thread answered once with 429 is tried again and shows in the dock"]
    }
  ]
});

// Defects the DOCK-1 verifier found (PR 54). The first two failed on d31cb094 and pass on
// 9af39400; the last two fail on 9af39400.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const member = { email: "e2e-dock@example.test", password: "e2e-dock-password" };

const chatColumn = (page: Page) => page.locator("[data-dock-chat]");
const dockHead = (page: Page) => chatColumn(page).locator("header").first();

// DOCK-1: fails where the dock's head looks for its title only in the sidebar's loaded rows. A
// conversation started from an asset ("Edit with agent") has no message yet, and an older one is
// past the first page: both are called "Chat".
test("the dock's head names its conversation also when the sidebar has not loaded its row", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, member);
  const title = `Not listed yet ${Date.now()}`;
  const conversation = await createConversation(page, title);
  const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);

  await page.goto(`/w/${workspace}/agents?chat=${conversation.id}`);
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
  await expect(chatColumn(page).getByPlaceholder("Message")).toBeVisible();
  await expect(dockHead(page)).toContainText(title);
});

// DOCK-1 round 2: fails because a first load of a thread never blocks the composer
// (`use-conversation-controller.ts` keeps "ready" while it loads), so on a slow connection a
// message typed into the dock of a refused link is still sent and refused with an alert.
test("on a slow connection, a message typed into the dock of a refused link is not sent", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, member);
  const own = await createConversation(page, `Own ${Date.now()}`);
  const workspace = encodeURIComponent(own.collaborationWorkspaceId);
  const missing = `conv_${randomUUID()}`;
  let threadCalls = 0;
  let refusedAt = 0;
  await page.route(`**/api/v1/conversations/${missing}/thread`, async (route) => {
    threadCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const response = await route.fetch();
    expect(response.status()).toBe(404);
    await route.fulfill({ response });
    refusedAt = Date.now();
  });
  const refusedSends: string[] = [];
  page.on("response", (response) => {
    if (response.request().method() === "POST" && response.status() === 404) {
      refusedSends.push(new URL(response.url()).pathname);
    }
  });

  await page.goto(`/w/${workspace}/agents?chat=${missing}`);
  const composer = chatColumn(page).getByPlaceholder("Message");
  await composer.fill("first words to a shared link");
  await composer.press("Enter");

  await expect(page).toHaveURL(new RegExp(`/w/${workspace}/agents$`, "u"), { timeout: 10_000 });
  await expect(dockHead(page)).toContainText("New chat");
  expect(Date.now() - refusedAt).toBeLessThan(2_000);
  // What was typed stays in the composer of the empty dock.
  await expect(composer).toHaveValue("first words to a shared link");
  await page.waitForTimeout(1_000);
  expect(refusedSends).toEqual([]);
  expect(threadCalls).toBe(1);
  await expect(chatColumn(page).getByRole("alert")).toHaveCount(0);
});

// DOCK-1 round 2: fails because the thread query now gives up on every 4xx, also on 429 (and
// 408), which ask to be tried again; the dock then keeps a titled conversation without messages.
test("a thread answered once with 429 is tried again and shows in the dock", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, member);
  const conversation = await createConversation(page, `Rate limited ${Date.now()}`);
  const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);
  let calls = 0;
  await page.route(`**/api/v1/conversations/${conversation.id}/thread`, async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "RATE_LIMITED", message: "Try again later" } })
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/w/${workspace}/agents?chat=${conversation.id}`);
  await expect.poll(() => calls, { timeout: 10_000 }).toBeGreaterThan(1);
  await expect(chatColumn(page).getByPlaceholder("Message")).toBeEnabled();
  await expect(chatColumn(page).getByRole("alert")).toHaveCount(0);
});

// DOCK-1 round 2: a readable thread on a slow connection blocks the send until it is there,
// keeps what was typed, and lets it go once loaded.
test("on a slow connection, the dock holds what was typed until its thread is there", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, member);
  const conversation = await createConversation(page, `Slow ${Date.now()}`);
  const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);
  let threadAnswered = false;
  await page.route(`**/api/v1/conversations/${conversation.id}/thread`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
    threadAnswered = true;
  });
  const sendsBeforeLoad: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && !threadAnswered && request.url().includes(conversation.id)) {
      sendsBeforeLoad.push(new URL(request.url()).pathname);
    }
  });

  await page.goto(`/w/${workspace}/agents?chat=${conversation.id}`);
  const composer = chatColumn(page).getByPlaceholder("Message");
  await composer.fill("words typed while it loads");
  await composer.press("Enter");
  const send = chatColumn(page).getByRole("button", { name: "Send message" });
  await expect(send).toBeDisabled();
  // A line says why: the conversation is still on its way.
  const loading = chatColumn(page).getByTestId("thread-loading");
  await expect(loading).toHaveText("Loading conversation");

  await expect(send).toBeEnabled({ timeout: 10_000 });
  await expect(loading).toHaveCount(0);
  await expect(composer).toHaveValue("words typed while it loads");
  expect(sendsBeforeLoad).toEqual([]);
  await expect(page).toHaveURL(new RegExp(`chat=${conversation.id}$`, "u"));
});

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  await page.goto("/");
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** A conversation without a message, as "Edit with agent" starts one. */
async function createConversation(
  page: Page,
  title: string
): Promise<{ id: string; collaborationWorkspaceId: string }> {
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations`, {
    data: { title }
  });
  expect(created.ok()).toBe(true);
  return z
    .object({ id: z.string(), collaborationWorkspaceId: z.string() })
    .parse(await created.json());
}
