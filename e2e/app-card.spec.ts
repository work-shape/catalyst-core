import { randomUUID } from "node:crypto";
import { signIn } from "./inbox-fixtures";
import { sendToolCall } from "./page-surface-fixtures";
import { expect, test } from "./test";

// Check 68 (APPCARD-1): a conversation in which the agent saved one App three times shows one
// App card, at the newest save, with "Open" and "Publish". It reads "Published" after the
// person publishes from it, and the agent then continues without a message typed by the person.
// Fails without the change: each save left a line of its own with "Share".

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

test("three saves of one App leave one card, which publishes and tells the conversation", async ({
  page
}) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 8);
  const title = `Findings ${tag}`;
  const folder = `findings-${tag}`;
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, superadmin);
  // A conversation of the person's own space: an App is made only where no one else reads along.
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);

  await sendToolCall(page, "workspace.write_file", {
    path: `${folder}/index.html`,
    content: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`
  });
  await sendToolCall(page, "workspace.open", { path: folder });
  for (let save = 0; save < 3; save += 1) {
    await sendToolCall(page, "app.save", { path: folder, name: title });
  }

  // One card for the App; the folder's preview has the App's card stand for it.
  const card = page.getByTestId("app-card");
  await expect(card).toHaveCount(1);
  await expect(page.getByTestId("page-card")).toHaveCount(0);
  await expect(card).toContainText(title);
  await expect(card.getByTestId("app-card-state")).toHaveText(
    "Saved · only for you, not published yet"
  );
  await expect(card.getByTestId("app-card-open")).toHaveText("Open");
  await expect(page.getByText("Share", { exact: true })).toHaveCount(0);

  // Publish asks "For whom?" in the dialog and makes the draft live.
  await card.getByTestId("app-card-publish").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const publish = dialog.getByRole("button", { name: "Publish", exact: true });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByTestId("app-card-state")).toHaveText("Published");
  await expect(card.getByTestId("app-card-publish")).toHaveCount(0);

  // The conversation is told, as the person, and its agent goes on from there.
  await expect(page.locator('[data-role="user"]').last()).toContainText(`I published “${title}”.`);
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(
    `I published “${title}”.`,
    { timeout: 60_000 }
  );
});
