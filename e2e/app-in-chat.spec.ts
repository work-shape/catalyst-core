import type { FrameLocator, Page } from "@playwright/test";
import { z } from "zod";
import { pageName, pageSurface, plainPageSource, sendToolCall } from "./page-surface-fixtures";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// An App made in a plain chat. The person talks to an agent whose definition lists no tool of
// a Page; the conversation offers them anyway. The Page shows beside the chat from the start
// of its first save, building, and then as the Page. The agent keeps it as an App on the
// person's word: the App's draft opens beside the chat from the same files, and the
// conversation is about the App. Each later save of the Page writes the App's draft, which
// reloads in place, and opens no Page. After a reload the conversation opens the App and its
// saves still write it. Fails without A3: the agent of this conversation has no page.save,
// and page.save_as_app does not exist.

/** The person of this spec, from `tests/fixtures/e2e-app.yaml`. */
const person = { email: "e2e-app-in-chat@example.test", password: "e2e-app-in-chat-password" };

const pageFolder = "revenue";
const SECOND_HEADING = "Margin calculator with tax";
const THIRD_HEADING = "Margin calculator with tax and discounts";

const assetSchema = z.looseObject({ draftRevision: z.number() });

/** The document inside the frame of the surface of `kind` beside the conversation. */
function documentIn(page: Page, kind: "page" | "app_edit"): FrameLocator {
  return page
    .locator(`aside[data-surface-kind="${kind}"]`)
    .getByTestId("page-preview-frame")
    .contentFrame()
    .frameLocator("iframe");
}

/** Lets the agent write one file of the Page's folder. */
async function writeFile(page: Page, path: string, content: string): Promise<void> {
  await sendToolCall(page, "workspace.write_file", { path: `${pageFolder}/${path}`, content });
}

const indexWith = (heading: string) =>
  (plainPageSource["index.html"] ?? "").replaceAll("Margin calculator", heading);

test("a Page built in a plain chat becomes an App, which the next saves of the Page change in place", async ({
  page
}, testInfo) => {
  // An App's id is taken once for the whole instance, so a repeated or retried run names its
  // App after the attempt.
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  const appTitle = attempt === 0 ? "Margin desk" : `Margin desk ${attempt}`;
  const appId = attempt === 0 ? "margin-desk" : `margin-desk-${attempt}`;
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(30_000);
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // The plain chat: the person's own workspace, where the interface starts.
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+/u);
  const workspaceId = decodeURIComponent(new URL(page.url()).pathname.split("/")[2] ?? "");
  const draftRevision = async () =>
    assetSchema.parse(
      await (
        await page.request.get(`${apiOrigin}/api/v1/assets/app/${appId}?workspaceId=${workspaceId}`)
      ).json()
    ).draftRevision;

  // The agent that lists no tool at all.
  await page
    .getByRole("button", { name: /^Select agent/u })
    .first()
    .click();
  await page.getByRole("option", { name: /Research Assistant/u }).click();
  await expect(page.getByRole("button", { name: /^Select agent/u }).first()).toHaveAccessibleName(
    "Select agent: Research Assistant"
  );

  // The agent writes the Page's files. Nothing opens beside the chat for a file.
  await writeFile(page, "app.yaml", plainPageSource["app.yaml"] ?? "");
  await writeFile(page, "index.html", indexWith("Margin calculator"));
  await expect(page.locator("aside[data-surface-kind]")).toBeHidden();

  // The first save opens the Page beside the chat while it builds, and then the Page.
  const building = page.locator('aside[data-surface-kind="page_building"]');
  const sawBuilding = building.waitFor({ state: "visible", timeout: 60_000 });
  await sendToolCall(page, "page.save", { name: pageName, directory: pageFolder });
  await sawBuilding;
  await expect(building).toHaveCount(0);
  const surface = pageSurface(page);
  await expect(surface).toBeVisible();
  await expect(surface).toContainText("Revision 1");
  await expect(
    documentIn(page, "page").getByRole("heading", { name: "Margin calculator" })
  ).toBeVisible();

  // The person asks to keep it as an App: the agent saves the same Page as one, without a
  // second build. The App's draft opens beside the chat, and the chat is about the App.
  await sendToolCall(page, "page.save_as_app", { page: pageName, name: appId, title: appTitle });
  const app = page.locator('aside[data-surface-kind="app_edit"]');
  await expect(app).toBeVisible();
  await expect(app).toHaveAccessibleName(appTitle);
  await expect(
    documentIn(page, "app_edit").getByRole("heading", { name: "Margin calculator" })
  ).toBeVisible();
  const subject = page.getByTestId("conversation-subject");
  await expect(subject).toHaveAttribute("data-subject-kind", "app");
  await expect(subject).toContainText(appTitle);
  // The call reads as what it did, in the run's Work history.
  const message = page.locator('[data-role="assistant"]').last();
  const history = message.getByRole("button", { name: /^Work history/u });
  await expect(history).toHaveAttribute("aria-expanded", "false");
  await history.click();
  await expect(message.getByTestId("tool-call-fold-sentence")).toHaveText(
    `Saved the Page as the app ${appTitle}`
  );
  expect(await draftRevision()).toBe(1);

  // The next save of the Page writes the App's draft: the draft reloads in place and no Page
  // opens beside the chat.
  await writeFile(page, "index.html", indexWith(SECOND_HEADING));
  await sendToolCall(page, "page.save", { name: pageName, directory: pageFolder });
  await expect(
    documentIn(page, "app_edit").getByRole("heading", { name: SECOND_HEADING })
  ).toBeVisible();
  await expect(page.locator('aside[data-surface-kind="page"]')).toHaveCount(0);
  await expect(page.getByTestId("page-card").last()).toContainText(
    `Revision 2, saved to the draft of ${appTitle}`
  );
  expect(await draftRevision()).toBe(2);

  // Coming back to the conversation opens the App, and its saves still write the App.
  await page.reload();
  await expect(app).toBeVisible();
  await writeFile(page, "index.html", indexWith(THIRD_HEADING));
  await sendToolCall(page, "page.save", { name: pageName, directory: pageFolder });
  await expect(
    documentIn(page, "app_edit").getByRole("heading", { name: THIRD_HEADING })
  ).toBeVisible();
  await expect(page.locator('aside[data-surface-kind="page"]')).toHaveCount(0);
  expect(await draftRevision()).toBe(3);

  // On a phone the App lies over the chat, and nothing reaches past the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(app).toBeVisible();
  await expect(app).toHaveAttribute("data-surface-mode", "covering");
  await expect(
    documentIn(page, "app_edit").getByRole("heading", { name: THIRD_HEADING })
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
