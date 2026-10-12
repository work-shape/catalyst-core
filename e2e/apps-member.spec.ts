import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { z } from "zod";
import {
  pageSource,
  pageSurface,
  patchThatAdds,
  savePage,
  writePageFiles
} from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// What a member who only uses an App is shown of it, beside what its builder is shown: the list
// and the head name the App and leave out its revision, its id and its workspace, and the head
// offers the link as one button where a builder has a menu. Fails without the member view: the
// member reads "Published · revision 1" in both places and finds a menu of one item.

/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;

/** The builder and the member, from `tests/fixtures/e2e-app.yaml`. */
const admin = { email: "e2e-apps@example.test", password: "e2e-apps-password" };
const member = { email: "e2e-apps-member@example.test", password: "e2e-apps-member-password" };

const WORKSPACE = "Field team";
const HEADING = "Trips overview";
const PUBLISHED = /(?:Published · revision|Veröffentlicht · Revision) 1/u;

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
  await writePageFiles(page, patchThatAdds(pageSource(HEADING)));
  await savePage(page);
  const surface = pageSurface(page);
  await surface.getByRole("button", { name: "Save as app" }).click();
  const saveDialog = page.getByRole("dialog");
  await saveDialog.getByRole("textbox", { name: /^Name/u }).fill(appName);
  await expect(saveDialog.getByRole("textbox", { name: /^ID/u })).toHaveValue(appId);
  await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${appPath}/edit$`, "u"));
  const edit = page.getByTestId("app-edit");
  await expect(appIn(page, "app-edit").getByRole("heading", { name: HEADING })).toBeVisible();
  // The App is open inside its workspace, so the head of its draft does not name it.
  await expect(edit.locator("header").first()).not.toContainText(WORKSPACE);
  await edit.getByRole("button", { name: "Publish", exact: true }).click();
  const publishDialog = page.getByRole("dialog", { name: `Publish “${appName}”?` });
  await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publishDialog).toBeHidden();

  // The builder's list names the revision and the id, and no row names the workspace it is in.
  await page.goto(appsPath);
  const builderList = page.getByTestId("apps-area").getByRole("list");
  const builderListReady = async () => {
    await expect(builderList).toContainText(PUBLISHED);
  };
  await builderListReady();
  await expect(builderList).toContainText(appId);
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
  await memberList.getByText(appName, { exact: true }).click();
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
});
