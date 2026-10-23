import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// chat.catalyst, 22 Oct 2026: the first letter typed into the composer threw "Maximum update
// depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop." Each
// test types into the composer as a person does, in the states the composer starts from; the
// suite's fixture fails a test on any page error, the loop's included.

const member = { email: "e2e-user@example.test", password: "e2e-user-password" };
const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const composerOf = (page: Page) => page.getByPlaceholder(/^(?:Message|Nachricht)$/u);

async function typeOneLetter(page: Page, before = "") {
  const composer = composerOf(page);
  await composer.click();
  await composer.press("End");
  await page.keyboard.type("a");
  await expect(composer).toHaveValue(`${before}a`);
  // A loop shows the error page in place of the composer a moment after the keystroke.
  await page.waitForTimeout(300);
  await expect(composer).toHaveValue(`${before}a`);
  await expect(page.getByText(/Maximum update depth exceeded/u)).toHaveCount(0);
}

for (const locale of ["en", "de"] as const) {
  test(`one letter typed into a new chat stays there (${locale})`, async ({ page }) => {
    await signIn(page, member);
    await page.evaluate(
      (chosen) => window.localStorage.setItem("vivd-catalyst:locale", chosen),
      locale
    );
    await page.reload();
    await expect(composerOf(page)).toBeVisible();
    await typeOneLetter(page);
  });
}

test("a slash typed into the composer stays there", async ({ page }) => {
  await signIn(page, member);
  const composer = composerOf(page);
  await composer.click();
  await page.keyboard.type("/");
  await expect(composer).toHaveValue("/");
  await typeOneLetter(page, "/");
});

test("one letter typed beside an attachment stays there", async ({ page }) => {
  await signIn(page, member);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes of the composer typing test")
  });
  const form = page.locator("form").filter({ has: composerOf(page) });
  await expect(form.getByText("notes.txt")).toBeVisible();
  await typeOneLetter(page);
});

test("one letter typed after a restored draft stays there", async ({ page }) => {
  await signIn(page, member);
  const title = `Typing after a draft ${randomUUID()}`;
  await startConversation(page, title);
  await page.goto("/");
  const row = page.getByTestId("conversation-row").filter({ hasText: title });
  await row.getByRole("button").first().click();
  await composerOf(page).fill("Draft");
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(composerOf(page)).toHaveValue("");
  await row.getByRole("button").first().click();
  await expect(composerOf(page)).toHaveValue("Draft");
  await typeOneLetter(page, "Draft");
});

/** A conversation with one finished exchange, listed in the rail. */
async function startConversation(page: Page, title: string) {
  const started = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations/runs`, {
    data: {
      idempotencyKey: randomUUID(),
      conversation: { title },
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
      const snapshot = z
        .object({ activeRun: z.unknown().optional(), messages: z.array(z.unknown()) })
        .parse(await thread.json());
      return { running: snapshot.activeRun !== undefined, messages: snapshot.messages.length };
    })
    .toEqual({ running: false, messages: 2 });
}
