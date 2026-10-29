import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { apiBaseUrl, createListedConversation, test } from "./chat-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect } from "./test";
import { uiOrigin } from "./view-fixtures";

const UPLOAD_FAILS = "a picture whose upload failed stays in the composer and says so in German";

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "picture-upload-gateway-failure",
        reason:
          "The test answers the upload with 502 to show what the composer does with a failed upload.",
        matches: requestAnswered(502),
        path: /^\/api\/v1\/conversations\/[^/]+\/draft-attachments$/u,
        tests: [UPLOAD_FAILS]
      }
    ]
  }
});

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** A ready chip names the file's size, in either language. */
const READY = `${PNG.byteLength} B`;

/** What the stub model says for each picture that reached it. */
const received = (filename: string) =>
  `Image received: ${filename} (image/png, ${PNG.byteLength} bytes).`;

async function attach(page: Page, filename: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: PNG
  });
}

function userMessages(page: Page): Locator {
  return page.locator('[data-role="user"]');
}

function assistantMessages(page: Page): Locator {
  return page.locator('[data-role="assistant"]');
}

/** The picture of a message, loaded. */
async function expectPicture(scope: Locator, filename: string): Promise<void> {
  const image = scope.getByRole("img", { name: filename });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
}

test("a picture goes with its message, with text and alone, the model sees it, and the history keeps it", async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  const input = page.getByPlaceholder("Message");
  const send = page.getByRole("button", { name: "Send message" });

  await attach(page, "with-text.png");
  await input.fill("here is a screenshot");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(userMessages(page).last()).toContainText("here is a screenshot");
  await expectPicture(userMessages(page).last(), "with-text.png");
  await expect(assistantMessages(page).last()).toContainText(received("with-text.png"));

  await attach(page, "alone.png");
  await expect(send).toBeEnabled();
  await send.click();
  await expectPicture(userMessages(page).last(), "alone.png");
  await expect(assistantMessages(page).last()).toContainText(received("alone.png"));
  // Each answer sees the pictures of its own message only.
  await expect(assistantMessages(page).filter({ hasText: received("alone.png") })).toHaveCount(1);

  await page.reload();
  await expectPicture(
    userMessages(page).filter({ hasText: "here is a screenshot" }),
    "with-text.png"
  );
  await expectPicture(userMessages(page).last(), "alone.png");
});

test("a picture sent during a run waits in the queue with its message, and Edit brings it back", async ({
  page
}) => {
  test.setTimeout(90_000);
  const suffix = Date.now();
  const held = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations/runs`, {
    data: {
      idempotencyKey: randomUUID(),
      conversation: { title: `Picture queue ${suffix}` },
      message: { text: `/tool e2e.confirm_note ${JSON.stringify({ text: `picture-${suffix}` })}` }
    }
  });
  expect(held.ok()).toBe(true);
  const { conversation } = z
    .object({ conversation: z.object({ id: z.string() }) })
    .parse(await held.json());
  await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);
  await expect(page.getByTestId("tool-decision-card")).toBeVisible();

  const input = page.getByPlaceholder("Message");
  const queue = page.getByRole("region", { name: "Queued messages" });
  const chip = page.getByTitle("queued.png", { exact: true });
  const text = `The screenshot of the error ${suffix}`;
  await attach(page, "queued.png");
  await expect(chip).toContainText(READY);
  await input.fill(text);
  // Enter during the reader's own run: a message with a file waits for the answer.
  await input.press("Enter");
  await expect(queue.getByText(text)).toBeVisible();
  await expectPicture(queue, "queued.png");
  await expect(queue).toContainText("queued.png");
  await expect(chip).toHaveCount(0);

  // Edit takes text and picture back into the composer.
  await queue.getByRole("button", { name: "Edit" }).click();
  await expect(queue).toHaveCount(0);
  await expect(input).toHaveValue(text);
  await expect(chip).toContainText(READY);

  await input.press("Enter");
  await expectPicture(queue, "queued.png");
  await page
    .getByTestId("tool-decision-card")
    .getByRole("button", { name: "Allow", exact: true })
    .click();

  // It starts as the next turn, picture included, and the model sees the picture.
  await expectPicture(userMessages(page).filter({ hasText: text }), "queued.png");
  await expect(assistantMessages(page).last()).toContainText(received("queued.png"));
  await expect(queue).toHaveCount(0);
});

test(UPLOAD_FAILS, async ({ page }) => {
  test.setTimeout(90_000);
  const conversation = await createListedConversation(page, `Picture upload ${Date.now()}`);
  await page.addInitScript(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);
  const input = page.getByPlaceholder("Nachricht");
  const send = page.getByRole("button", { name: "Nachricht senden" });
  await expect(input).toBeVisible();

  // The gateway gives up on every attempt.
  const uploads = new RegExp(
    `/api/v1/conversations/${conversation.id}/draft-attachments(?:\\?|$)`,
    "u"
  );
  await page.route(uploads, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 502, body: "Bad Gateway" })
      : route.fallback()
  );
  await attach(page, "broken.png");
  const chip = page.getByTitle("broken.png", { exact: true });
  await expect(page.getByText("„broken.png“ konnte nicht hochgeladen werden.")).toBeVisible({
    timeout: 20_000
  });
  await expect(chip).toContainText("Fehlgeschlagen");
  await input.fill("mit Bild");
  await expect(send).toBeDisabled();

  // Once the upload goes through, the picture goes with the message.
  await page.unroute(uploads);
  await chip.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(chip).toContainText(READY);
  await expect(send).toBeEnabled();
  await send.click();
  await expectPicture(userMessages(page).last(), "broken.png");
  await expect(assistantMessages(page).last()).toContainText(received("broken.png"));
});
