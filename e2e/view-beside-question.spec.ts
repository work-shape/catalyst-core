import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { signIn } from "./inbox-fixtures";
import { expect, test } from "./test";

// A view the agent shows, and then a question about it in the same run: the run ends its turn
// with the question, and the view stays in sight above the card while the question waits, also
// after a reload. The view's row in the work history opens the view again with one click.
// Fails without the change: a run that ends on a question has no final answer, so its view
// stood only in a closed row of the work, and the row's chevron opened its technical details.

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const shotsDir = process.env.E2E_SHOTS_DIR;
const viewTitle = "Proposal: split the skill";

const view = {
  title: viewTitle,
  mode: "inline",
  html: "<main><h1>Proposal</h1><p>Part one reads the documents, part two writes the mail.</p></main>"
};

const question = {
  question: "Where should the request mail go?",
  options: [
    { label: "Into part one", recommended: true, description: "Part two only asks for more" },
    { label: "Into part two" }
  ]
};

/** The view's frame as the thread shows it. */
function viewFrames(page: Page) {
  return page.locator(`iframe[title="${viewTitle}"]`);
}

test("a view shown before a question stays in sight while the question waits", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, superadmin);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
  await page.reload();

  // One run: the agent shows the view, then asks about it.
  const composer = page.getByPlaceholder(/^(?:Message|Nachricht)$/u);
  await composer.fill(
    `/tool show_view ${JSON.stringify(view)}\n/tool ask_question ${JSON.stringify(question)}`
  );
  await page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u }).click();

  const card = page.getByTestId("question-card").first();
  await expect(card).toHaveAttribute("data-state", "open", { timeout: 60_000 });
  await expect(page).toHaveURL(/\/w\/[^/]+\/c\/[^/]+$/u);
  // The run has ended its turn and the thread reads it from the stored messages.
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();

  // The view stands above the question that asks about it, and shows what the agent wrote.
  const shown = viewFrames(page).first();
  await expect(shown).toBeVisible();
  await expect(viewHeading(page, 0)).toBeVisible();
  await expectAbove(shown, card);
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await answerOf(page).screenshot({ path: join(shotsDir, "view-beside-question.png") });
  }

  // So it does after a reload.
  await page.reload();
  await expect(card).toHaveAttribute("data-state", "open");
  await expect(viewHeading(page, 0)).toBeVisible();
  await expectAbove(viewFrames(page).first(), card);

  // The view's row in the work history opens the view with one click.
  await page.getByTestId("assistant-work-group-trigger").first().click();
  const row = page.getByRole("button", { name: /Showed an overview/u }).first();
  await expect(row).toBeVisible();
  await expect(viewFrames(page)).toHaveCount(1);
  await row.click();
  await expect(viewFrames(page)).toHaveCount(2);
  await expect(viewHeading(page, 0)).toBeVisible();
  if (shotsDir) {
    await answerOf(page).screenshot({ path: join(shotsDir, "view-beside-question-row.png") });
  }
});

/** The heading of the view the agent wrote, in the `index`th frame of it on the page. */
function viewHeading(page: Page, index: number) {
  return page
    .frameLocator(`iframe[title="${viewTitle}"] >> nth=${index}`)
    .frameLocator("iframe")
    .getByRole("heading", { name: "Proposal" });
}

/** The agent's answer of the run, for its picture. */
function answerOf(page: Page): Locator {
  return page.locator('[data-role="assistant"]').last();
}

async function expectAbove(upper: Locator, lower: Locator): Promise<void> {
  const [upperBox, lowerBox] = await Promise.all([upper.boundingBox(), lower.boundingBox()]);
  expect(upperBox?.y ?? Infinity).toBeLessThan(lowerBox?.y ?? -Infinity);
}
