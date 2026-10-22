import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { z } from "zod";
import {
  pageSource,
  pageSurface,
  savePage,
  sendToolCall,
  writePageFiles
} from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { shootLocales, shootThemes } from "./surface-shots";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";
import { chooseWorkspaceAudience } from "./app-audience";

/** The address of the draft of the App at `appPath`, outside the App's own addresses. */
const draftPathOf = (appPath: string) => appPath.replace("/apps/", "/app-drafts/");

// What a member who only uses an App is shown of it, beside what its builder is shown: the list
// and the head name the App and leave out its revision, its id and its workspace, and the head
// offers the link as one button where a builder has a menu. Fails without the member view: the
// member reads "Published · version 1" in both places and finds a menu of one item.

/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;

/** The builder and the member, from `tests/fixtures/e2e-users/apps.yaml`. */
const admin = { email: "e2e-apps@example.test", password: "e2e-apps-password" };
const member = { email: "e2e-apps-member@example.test", password: "e2e-apps-member-password" };

const WORKSPACE = "Field team";
const HEADING = "Trips overview";
const PUBLISHED = /(?:Published · version|Veröffentlicht · Version) 1/u;

const idSchema = z.object({ id: z.string() });

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // The instance knows a person of the config from their first call on.
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
}

/** The App inside the frame of the screen with this test id. */
function appIn(page: Page, screen: "app-view" | "app-edit"): FrameLocator {
  return page
    .getByTestId(screen)
    .getByTestId("page-preview-frame")
    .contentFrame()
    .frameLocator("iframe");
}

const VARIANTS = (["light", "dark"] as const).flatMap((theme) =>
  (["en", "de"] as const).flatMap((locale) =>
    ([1440, 390] as const).map((width) => [theme, locale, width] as const)
  )
);

/**
 * Pictures of the screen the page is on, in both themes and languages at both widths. The
 * language and the theme are read when the interface loads, so each variant loads the address
 * again and waits for `ready`.
 */
async function shoot(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  const show = async ([theme, locale, width]: (typeof VARIANTS)[number]) => {
    await page.evaluate(
      ([themeValue, localeValue]) => {
        window.localStorage.setItem("vivd-catalyst:theme", themeValue);
        window.localStorage.setItem("vivd-catalyst:locale", localeValue);
      },
      [theme, locale] as const
    );
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.reload();
    await ready();
  };
  for (const variant of VARIANTS) {
    await show(variant);
    await page.screenshot({
      path: join(shotsDir, `${name}-${variant.join("-")}.png`),
      animations: "disabled"
    });
  }
  await show(["light", "en", 1440]);
}

test("a member who uses an App is shown the App and a builder its revision", async ({
  page,
  browser,
  baseURL,
  pageErrors
}, testInfo) => {
  // An App's id is taken once for the whole instance, so a repeated or retried run on the same
  // instance names its App after the attempt.
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  const appName = attempt === 0 ? "Trip planner" : `Trip planner ${attempt}`;
  const appId = attempt === 0 ? "trip-planner" : `trip-planner-${attempt}`;
  test.setTimeout(shotsDir ? 600_000 : 240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, admin);
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, member);
  for (const each of [page, memberPage]) {
    each.setDefaultTimeout(30_000);
  }

  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: WORKSPACE }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const added = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/workspaces/${workspaceId}/members`,
    { data: { email: member.email } }
  );
  expect(added.ok()).toBe(true);
  const appsPath = `/w/${workspaceId}/apps`;
  const appPath = `${appsPath}/${appId}`;

  // The builder saves a Page as an App and publishes it.
  await page.goto(`/w/${workspaceId}`);
  await writePageFiles(page, pageSource(HEADING));
  await savePage(page);
  const surface = pageSurface(page);
  await surface.getByRole("button", { name: "Save as app" }).click();
  const saveDialog = page.getByRole("dialog");
  await saveDialog.getByRole("textbox", { name: /^Name/u }).fill(appName);
  await expect(saveDialog.getByRole("textbox")).toHaveCount(1);
  await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${draftPathOf(appPath)}$`, "u"));
  const edit = page.getByTestId("app-edit");
  await expect(appIn(page, "app-edit").getByRole("heading", { name: HEADING })).toBeVisible();
  // The App is open inside its workspace, so the head of its draft does not name it.
  await expect(edit.locator("header").first()).not.toContainText(WORKSPACE);
  await edit.getByRole("button", { name: "Publish", exact: true }).click();
  const publishDialog = page.getByRole("dialog", { name: `Publish “${appName}”?` });
  // The member uses the App below: it is published for the workspace (SHARE-1).
  await chooseWorkspaceAudience(publishDialog);
  await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publishDialog).toBeHidden();

  // The builder's list names the revision and the id, and no row names the workspace it is in.
  await page.goto(appsPath);
  const builderList = page.getByTestId("apps-area").getByRole("list");
  const builderListReady = async () => {
    await expect(builderList).toContainText(PUBLISHED);
  };
  await builderListReady();
  // A builder is shown the revision, and no card shows the App's id (UXA-1a).
  await expect(builderList).not.toContainText(appId);
  await expect(builderList).not.toContainText(WORKSPACE);
  await shoot(page, "apps-list-builder", builderListReady);

  // The member's list names the App and nothing a builder works with.
  await memberPage.goto(appsPath);
  const memberList = memberPage.getByTestId("apps-area").getByRole("list");
  const memberListReady = async () => {
    await expect(memberList.getByText(appName, { exact: true })).toBeVisible();
  };
  await memberListReady();
  await expect(memberList).not.toContainText(/Published|revision/iu);
  await expect(memberList).not.toContainText(appId);
  await expect(memberList).not.toContainText(WORKSPACE);
  await shoot(memberPage, "apps-list-member", memberListReady);

  // The member's head names the App and offers its link as one button, without a menu.
  // The card's Open is named with the App it opens.
  await memberList.getByRole("link", { name: `Open ${appName}`, exact: true }).click();
  await expect(memberPage).toHaveURL(new RegExp(`${appPath}$`, "u"));
  const memberView = memberPage.getByTestId("app-view");
  const memberHead = memberView.locator("header").first();
  const memberViewReady = async () => {
    await expect(
      appIn(memberPage, "app-view").getByRole("heading", { name: HEADING })
    ).toBeVisible();
    await expect(memberView.getByRole("heading", { name: appName })).toBeVisible();
  };
  await memberViewReady();
  await expect(memberHead).not.toContainText(/Published|revision/iu);
  await expect(memberHead).not.toContainText(WORKSPACE);
  await expect(memberHead).not.toContainText(appId);
  await expect(memberView.getByRole("button", { name: "More actions" })).toHaveCount(0);
  await expect(memberPage.getByRole("button", { name: "Details" })).toHaveCount(0);
  await shoot(memberPage, "app-view-member", memberViewReady);
  await memberContext.grantPermissions(["clipboard-read", "clipboard-write"]);
  await memberHead.getByRole("button", { name: "Copy link" }).click();
  await expect(memberHead.getByRole("button", { name: "Link copied" })).toBeVisible();
  expect(await memberPage.evaluate(() => navigator.clipboard.readText())).toBe(
    `${uiOrigin}${appPath}`
  );
  await expect(memberPage.getByRole("menu")).toHaveCount(0);
  if (shotsDir) {
    await memberPage.screenshot({
      path: join(shotsDir, "app-view-member-link-copied-light-en-1440.png"),
      animations: "disabled"
    });
  }
  await expect(memberHead.getByRole("button", { name: "Copy link" })).toBeVisible();
  // DOCK-1: a shared link never carries the conversation of the dock beside the App.
  const docked = await requestWithOrigin(memberPage, "post", `${apiOrigin}/api/v1/conversations`, {
    data: { title: "Beside the App" }
  });
  expect(docked.ok()).toBe(true);
  const dockedId = idSchema.parse(await docked.json()).id;
  await memberPage.goto(`${appPath}?chat=${dockedId}`);
  await expect(memberPage.locator("[data-dock-chat]")).toHaveAttribute("data-chat-mode", "dock");
  await memberViewReady();
  await memberHead.getByRole("button", { name: "Copy link" }).click();
  await expect(memberHead.getByRole("button", { name: "Link copied" })).toBeVisible();
  expect(await memberPage.evaluate(() => navigator.clipboard.readText())).toBe(
    `${uiOrigin}${appPath}`
  );
  await memberContext.close();

  // The builder's head keeps the revision and the menu, and does not name the workspace.
  await page.goto(appPath);
  const view = page.getByTestId("app-view");
  const head = view.locator("header").first();
  const viewReady = async () => {
    await expect(appIn(page, "app-view").getByRole("heading", { name: HEADING })).toBeVisible();
    await expect(head).toContainText(PUBLISHED);
  };
  await viewReady();
  await expect(head).not.toContainText(WORKSPACE);
  await shoot(page, "app-view-builder", viewReady);
  const more = view.getByRole("button", { name: "More actions" });
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Details" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  // A press on the button right after the menu closed opens it again, while the closed menu
  // is still fading out.
  await page.keyboard.press("Escape");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  // The page head's "Chat" opens the App's draft page with a conversation about it in the dock.
  const draftPath = `/w/${workspaceId}/app-drafts/${appId}`;
  await page.getByTestId("dock-page-action").click();
  await expect(page).toHaveURL((url) => url.pathname === draftPath && url.searchParams.has("chat"));
  // The dock's head says what the conversation is about.
  const subject = page.getByTestId("dock-head");
  await expect(subject).toHaveAttribute("data-subject-kind", "app");
  await expect(subject).toContainText(`Working on: ${appName}`);
  // Nothing opens beside the dock: the App's page is the draft.
  await expect(page.locator("aside[data-surface-kind]")).toHaveCount(0);
  const draft = page.getByTestId("app-edit");
  const draftReady = async () => {
    await expect(
      draft
        .getByTestId("page-preview-frame")
        .contentFrame()
        .frameLocator("iframe")
        .getByRole("heading", { name: HEADING })
    ).toBeVisible();
  };
  await draftReady();
  await shootThemes(page, "app-from-page", draftReady);

  // In a plain conversation of the App's workspace that is the builder's own, the agent
  // opens the App: an App belongs to the workspace, so the open moves this tab, which sent the
  // message, from the chat route to the App's draft page with the conversation in the dock
  // (navigation check 27, Platform Access check 46's workspace-scoped open).
  const madePrivate = await requestWithOrigin(
    page,
    "patch",
    `${apiOrigin}/api/v1/workspaces/${workspaceId}`,
    { data: { defaultConversationVisibility: "private" } }
  );
  expect(madePrivate.ok(), await madePrivate.text()).toBe(true);
  await page.goto(`/w/${workspaceId}`);
  await sendToolCall(page, "platform.assets.open", { kind: "app", name: appId });
  await expect(page).toHaveURL((url) => url.pathname === draftPath && url.searchParams.has("chat"));
  const conversationId = new URL(page.url()).searchParams.get("chat") ?? "";
  const chatPath = `/w/${workspaceId}/c/${conversationId}`;
  await expect(subject).toHaveAttribute("data-subject-kind", "app");
  // The conversation keeps the line of the open, which leads to the App's page.
  const openedLine = page.getByTestId("asset-opened-line").last();
  await expect(openedLine).toHaveText(`Opened ${appName}`);
  await expect(openedLine.getByRole("link", { name: appName, exact: true })).toHaveAttribute(
    "href",
    draftPath
  );
  await expect(page.getByTestId("asset-opened-chip")).toHaveCount(0);
  await draftReady();
  await shootThemes(page, "app-from-chat", draftReady);
  await shootLocales(page, "nav-2-opened-line", async () => {
    await expect(page.getByTestId("asset-opened-line").last()).toBeVisible();
    await draftReady();
  });
  // The open added one step to the history: Back returns to the conversation.
  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === chatPath);
  await page.goForward();
  await expect(page).toHaveURL((url) => url.pathname === draftPath);

  // A second tab of the same person that shows this conversation never moves: it offers to
  // go to the asset instead. So does this tab on a page the person went to on their own.
  const second = await page.context().newPage();
  await second.setViewportSize({ width: 1280, height: 800 });
  await second.goto(chatPath);
  const appsList = `/w/${workspaceId}/apps`;
  await page.goto(`${appsList}?chat=${conversationId}`);
  await sendToolCall(page, "platform.assets.open", { kind: "app", name: appId });
  const chip = page.getByTestId("asset-opened-chip");
  await expect(chip).toContainText(`Opened ${appName}`);
  expect(new URL(page.url()).pathname).toBe(appsList);
  // The person turns to the second tab, which reads the conversation again as a shown tab does.
  await second.bringToFront();
  await second.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const secondChip = second.getByTestId("asset-opened-chip");
  const secondReady = async () => {
    await expect(secondChip).toBeVisible();
  };
  await secondReady();
  expect(new URL(second.url()).pathname).toBe(chatPath);
  await shootLocales(second, "nav-2-chip-second-tab", secondReady);
  await second.close();
  await page.bringToFront();
  // The press of "Go to it" is the person's own step: the page opens with the dock.
  await chip.getByRole("button", { name: "Go to it", exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === draftPath && url.searchParams.get("chat") === conversationId
  );
  await expect(chip).toHaveCount(0);
});
