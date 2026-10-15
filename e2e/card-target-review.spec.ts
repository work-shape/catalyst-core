import type { Page } from "@playwright/test";
import { z } from "zod";
import { pageSource, patchThatAdds, savePage, writePageFiles } from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// Verifier's test for CARD-1 (PR 53). A card that opens as a whole lays its target's area over
// everything in the card that is not a control. The App card still offers a thing that only a
// pointer reaches: the full date of the change as the title of its time. Fails at 3f2b2482: the
// point of the time is the target's, so the date never shows. The App's id left the card with
// UXA-1a; a pointer resting on the card reads its whole name.

const admin = { email: "e2e-apps@example.test", password: "e2e-apps-password" };
const idSchema = z.object({ id: z.string() });

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
}

test("the time on a card that opens as a whole stays the pointer's, and the card reads its name", async ({
  page
}, testInfo) => {
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  const appName = attempt === 0 ? "Card probe" : `Card probe ${attempt}`;
  const appId = attempt === 0 ? "card-probe" : `card-probe-${attempt}`;
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, admin);

  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: "Card probe" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;

  // A builder saves a Page as an App; its card opens the draft.
  await page.goto(`/w/${workspaceId}`);
  await writePageFiles(page, patchThatAdds(pageSource("Card probe")));
  await savePage(page);
  await page.getByRole("button", { name: "Save as app" }).click();
  const saveDialog = page.getByRole("dialog");
  await saveDialog.getByRole("textbox", { name: /^Name/u }).fill(appName);
  await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app-drafts/${appId}$`, "u"));

  await page.goto(`/w/${workspaceId}/apps`);
  const card = page.getByRole("listitem").filter({ hasText: appName }).locator("[data-card]");
  await expect(card.locator("[data-card-target]")).toHaveCount(1);

  const time = card.locator("time");
  const hit = await time.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return top !== null && node.contains(top);
  });
  expect(hit, "the time is under the pointer").toBe(true);
  await expect(card).not.toContainText(appId);
  // The title is under the target's area: the target reads the whole name to a resting pointer.
  await expect(card.locator("[data-card-target]")).toHaveAttribute("title", appName);
});

// Round 2 (c013a285). CardTarget keeps where a press began and drops the next click that lands
// more than 4 px from it. A press whose release never makes a click, as one dragged off the
// card, leaves that point behind; the next click from the keyboard comes at (0, 0) and is
// dropped. Fails at c013a285: Enter on the focused target opens nothing once.
test("a press dragged off a card does not swallow the next Enter on its target", async ({
  page
}) => {
  const signedIn = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: { email: "e2e-admin@example.test", password: "e2e-admin-password", rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/ui-library");
  await page
    .getByRole("navigation", { name: "Sections of the UI library" })
    .getByRole("button", { name: "Page structure", exact: true })
    .click();
  const sample = page.locator('[data-gallery-sample="card-target"]');
  const card = sample.locator("[data-card]");
  const done = sample.getByRole("status");
  await card.scrollIntoViewIfNeeded();

  // A press on the card's text, dragged off the card and released there.
  const box = await card.boundingBox();
  if (!box) {
    throw new Error("The card has no box.");
  }
  await page.mouse.move(box.x + 24, box.y + 24);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, box.y + box.height + 80, { steps: 8 });
  await page.mouse.up();

  await card.getByRole("button", { name: "Edit" }).focus();
  await page.keyboard.press("Enter");
  await expect(done).toHaveText("The editor opened.");
  await page.keyboard.press("Shift+Tab");
  await expect(card.locator("[data-card-target]")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(done).toHaveText("The chat started.");
});
