import type { FrameLocator, Page } from "@playwright/test";
import { z } from "zod";
import {
  expectShownRevision,
  pageSurface,
  plainPageSource,
  sendToolCall
} from "./page-surface-fixtures";
import { shootLocales, shootThemes } from "./surface-shots";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// An App made in a plain chat. The person talks to an agent whose definition lists no tool of
// an App; the conversation offers them anyway. What the agent opens shows beside the chat from
// the start of the open, building, and then as the preview. The agent keeps it as an App on the
// person's word, and nothing asks the person anything: the person moves to the App's draft page
// with the conversation in the dock, and the conversation is about the App. A later open writes
// nothing into the App; the next save writes its draft revision 2, which reloads in place. After
// a reload the dock keeps the conversation and its saves still write the App. Fails without
// OPEN-1: neither workspace.open nor app.save existed (apps-and-pages checks 53 and 55).

/** The person of this spec, from `tests/fixtures/e2e-app.yaml`. */
const person = { email: "e2e-app-in-chat@example.test", password: "e2e-app-in-chat-password" };

const pageFolder = "revenue";
const SECOND_HEADING = "Margin calculator with tax";
const THIRD_HEADING = "Margin calculator with tax and discounts";

const assetSchema = z.looseObject({ draftRevision: z.number() });

/** The document inside the frame of the surface of `kind` beside the conversation. */
function documentIn(page: Page, kind: "page"): FrameLocator {
  return page
    .locator(`aside[data-surface-kind="${kind}"]`)
    .getByTestId("page-preview-frame")
    .contentFrame()
    .frameLocator("iframe");
}

/** The document inside the preview of the App's draft page. */
function draftDocument(page: Page): FrameLocator {
  return page
    .getByTestId("app-edit")
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

test("what a plain chat opened becomes an App without a question, and its next save writes revision 2 in place", async ({
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

  // The agent writes the App's files. Nothing opens beside the chat for a file.
  await writeFile(page, "app.yaml", plainPageSource["app.yaml"] ?? "");
  await writeFile(page, "index.html", indexWith("Margin calculator"));
  await expect(page.locator("aside[data-surface-kind]")).toBeHidden();

  // The open shows the folder beside the chat while it builds, and then what it built.
  const building = page.locator('aside[data-surface-kind="page_building"]');
  const sawBuilding = building.waitFor({ state: "visible", timeout: 60_000 });
  await sendToolCall(page, "workspace.open", { path: pageFolder });
  await sawBuilding;
  await expect(building).toHaveCount(0);
  const surface = pageSurface(page);
  await expect(surface).toBeVisible();
  await expectShownRevision(surface, 1);
  await expect(
    documentIn(page, "page").getByRole("heading", { name: "Margin calculator" })
  ).toBeVisible();
  // After a reload the preview opens from its card in the thread.
  await shootThemes(page, "open-1-preview", async () => {
    await page
      .getByTestId("page-card")
      .last()
      .getByRole("button", { name: /^(?:Open|Öffnen)$/u })
      .click();
    await expect(
      documentIn(page, "page").getByRole("heading", { name: "Margin calculator" })
    ).toBeVisible();
  });

  // An open keeps nothing: no App of that name exists yet.
  expect(
    (
      await page.request.get(`${apiOrigin}/api/v1/assets/app/${appId}?workspaceId=${workspaceId}`)
    ).status()
  ).toBe(404);

  // The person asks to keep it as an App: the agent saves what the preview shows, without a
  // second build, and nothing asks the person anything. The conversation is about the App from
  // then on, and this tab, which sent the message, moves to the App's draft page with the
  // conversation in the dock.
  await sendToolCall(page, "app.save", { path: pageFolder, name: appTitle });
  const draftPath = `/w/${encodeURIComponent(workspaceId)}/app-drafts/${appId}`;
  await expect(page).toHaveURL((url) => url.pathname === draftPath && url.searchParams.has("chat"));
  await expect(
    draftDocument(page).getByRole("heading", { name: "Margin calculator" })
  ).toBeVisible();
  const subject = page.getByTestId("dock-head");
  await expect(subject).toHaveAttribute("data-subject-kind", "app");
  await expect(subject).toContainText(appTitle);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The call reads as what it did, in the run's Work history.
  const message = page.locator('[data-role="assistant"]').last();
  const history = message.getByRole("button", { name: /^Work history/u });
  await expect(history).toHaveAttribute("aria-expanded", "false");
  await history.click();
  await expect(message.getByTestId("tool-call-fold-sentence")).toHaveText(
    `Saved as the app ${appTitle}`
  );
  expect(await draftRevision()).toBe(1);

  // A later open shows the change and writes nothing into the App.
  await writeFile(page, "index.html", indexWith(SECOND_HEADING));
  await sendToolCall(page, "workspace.open", { path: pageFolder });
  await expect(page.getByTestId("page-card").last()).toHaveAttribute("data-revision", "2");
  expect(await draftRevision()).toBe(1);

  // The next save writes the App's draft revision 2: the preview gives way to the draft page,
  // which reloads in place.
  await sendToolCall(page, "app.save", { path: pageFolder, name: appTitle });
  await expect(draftDocument(page).getByRole("heading", { name: SECOND_HEADING })).toBeVisible();
  await expect(page.locator('aside[data-surface-kind="page"]')).toHaveCount(0);
  expect(await draftRevision()).toBe(2);
  await shootThemes(page, "open-1-draft-revision-2", async () => {
    await expect(draftDocument(page).getByRole("heading", { name: SECOND_HEADING })).toBeVisible();
  });

  // Coming back to the page keeps the conversation in the dock, and its saves still write
  // the App.
  await page.reload();
  await expect(draftDocument(page).getByRole("heading", { name: SECOND_HEADING })).toBeVisible();
  await writeFile(page, "index.html", indexWith(THIRD_HEADING));
  await sendToolCall(page, "workspace.open", { path: pageFolder });
  await expect(page.getByTestId("page-card").last()).toHaveAttribute("data-revision", "3");
  await sendToolCall(page, "app.save", { path: pageFolder, name: appTitle });
  await expect(draftDocument(page).getByRole("heading", { name: THIRD_HEADING })).toBeVisible();
  await expect(page.locator('aside[data-surface-kind="page"]')).toHaveCount(0);
  expect(await draftRevision()).toBe(3);

  // At 1280 with the dock open the page still says the App runs nowhere yet, whole: the state
  // stands at the end of the tab row, which has room whatever the actions take.
  await page.setViewportSize({ width: 1280, height: 800 });
  const draftState = () =>
    page
      .getByTestId("app-edit")
      .getByText(/^(?:Draft · not published|Entwurf · nicht veröffentlicht)$/u);
  const wholeState = async () => {
    await expect(draftState()).toBeVisible();
    expect(await draftState().evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  };
  await wholeState();
  await shootLocales(page, "nav-2-app-draft-dock", wholeState);

  // On a phone the dock lies over the page; "Show page" brings the draft in front, and
  // nothing reaches past the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show page", exact: true }).click();
  await expect(draftDocument(page).getByRole("heading", { name: THIRD_HEADING })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
