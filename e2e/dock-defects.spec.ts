import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Defects the DOCK-1 verifier found (PR 54). Both tests fail on d31cb094.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const member = { email: "e2e-dock@example.test", password: "e2e-dock-password" };

const chatColumn = (page: Page) => page.locator("[data-dock-chat]");
const dockHead = (page: Page) => chatColumn(page).locator("header").first();

// DOCK-1, acceptance check 25: fails while the dock retries the refused thread for about seven
// seconds. Meanwhile it offers the composer and "Open as full chat" for the conversation the
// person may not read; a message sent then is refused with "Conversation is not available" and
// its text is lost.
test("a link to a conversation the person may not read opens the empty dock at once, and a message typed meanwhile raises no error", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, member);
  const own = await createConversation(page, `Own ${Date.now()}`);
  const workspace = encodeURIComponent(own.collaborationWorkspaceId);
  const refusedSends: string[] = [];
  page.on("response", (response) => {
    if (response.request().method() === "POST" && response.status() === 404) {
      refusedSends.push(new URL(response.url()).pathname);
    }
  });

  await page.goto(`/w/${workspace}/agents?chat=conv_${randomUUID()}`);
  const composer = chatColumn(page).getByPlaceholder("Message");
  await composer.fill("first words to a shared link");
  await composer.press("Enter");

  // The refusal is one request of a few milliseconds: the dock is empty well within two seconds.
  await expect(page).toHaveURL(new RegExp(`/w/${workspace}/agents$`, "u"), { timeout: 2_000 });
  await expect(dockHead(page)).toContainText("New chat", { timeout: 2_000 });
  // Long enough for the retries of today to run out.
  await page.waitForTimeout(8_000);
  await expect(chatColumn(page).getByRole("alert")).toHaveCount(0);
  expect(refusedSends).toEqual([]);
});

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
