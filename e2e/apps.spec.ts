import type { FrameLocator, Page } from "@playwright/test";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { z } from "zod";
import {
  overviewRoute,
  pageSource,
  pageSurface,
  savePage,
  writePageFiles
} from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";
import { chooseWorkspaceAudience } from "./app-audience";
/** The address of the draft of the App at `appPath`, outside the App's own addresses. */
const draftPathOf = (appPath: string) => appPath.replace("/apps/", "/app-drafts/");
// The Apps of a workspace, from a Page built in chat to an App its members open: the Page is
// saved as an App, its draft is published for the workspace, a second member opens it and
// follows a link to its second route, sees no draft, gains Edit through a right on this App
// alone, and a discarded draft shows what is published again.
/** The people of this spec, from `tests/fixtures/e2e-users/apps.yaml`. */
const admin = { email: "e2e-apps@example.test", password: "e2e-apps-password" };
const member = { email: "e2e-apps-member@example.test", password: "e2e-apps-member-password" };
const WORKSPACE = "Sales team";
const PUBLISHED_HEADING = "Revenue overview";
const DRAFT_HEADING = "Revenue forecast";
/** The outside host the draft adds and the published revision does not list. */
const HELD_HOST = "rates.example.com";
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
test("a Page is saved as an App, published, opened by a second member and deep linked", async ({
  page,
  browser,
  baseURL,
  pageErrors,
  accessState: _accessState
}, testInfo) => {
  // An App's id is taken once for the whole instance, so a repeated or retried run on the same
  // instance names its App after the attempt.
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  const appName = attempt === 0 ? "Revenue board" : `Revenue board ${attempt}`;
  const appId = attempt === 0 ? "revenue-board" : `revenue-board-${attempt}`;
  test.setTimeout(240000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, admin);
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, member);
  // A click that finds nothing fails here and not at the end of the test.
  for (const each of [page, memberPage]) {
    each.setDefaultTimeout(30000);
  }
  // The workspace of the spec and its second member.
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
  // The Page is built in a conversation of the workspace and saved as an App by its name.
  await page.goto(`/w/${workspaceId}`);
  await writePageFiles(page, pageSource(PUBLISHED_HEADING));
  await savePage(page);
  const surface = pageSurface(page);
  await expect(surface).toBeVisible();
  await surface.getByRole("button", { name: /^(?:Save as app|Als App speichern)$/u }).click();
  const saveDialog = page.getByRole("dialog");
  await saveDialog.getByRole("textbox", { name: /^Name/u }).fill(appName);
  await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${draftPathOf(appPath)}$`, "u"));
  const edit = page.getByTestId("app-edit");
  await expect(edit.locator('[data-asset-status="draft"]')).toHaveText("Draft · not live");
  await expect(
    appIn(page, "app-edit").getByRole("heading", { name: PUBLISHED_HEADING })
  ).toBeVisible();
  // Published for the workspace, so its members use it.
  const publish = edit.getByRole("button", { name: "Publish", exact: true });
  await publish.click();
  const publishDialog = page.getByRole("dialog", { name: `Publish “${appName}”?` });
  await chooseWorkspaceAudience(publishDialog);
  await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publishDialog).toBeHidden();
  await expect(edit.locator('[data-asset-status="live"]')).toHaveText("Live");
  await expect(edit.locator('[data-asset-status="draft"]')).toHaveCount(0);
  // The member holds the use right alone, through membership: the list shows the published App,
  // and it opens from there.
  await memberPage.goto(appsPath);
  const memberArea = memberPage.getByTestId("apps-area");
  const memberCard = memberArea.getByRole("listitem").filter({ hasText: appName });
  await memberCard.getByRole("link", { name: `Open ${appName}`, exact: true }).click();
  await expect(memberPage).toHaveURL(new RegExp(`${appPath}$`, "u"));
  const memberApp = appIn(memberPage, "app-view");
  await expect(memberApp.getByRole("heading", { name: PUBLISHED_HEADING })).toBeVisible();
  // The App's own route becomes part of the address, and the address opens that route cold.
  await memberApp.getByText("Data", { exact: true }).click();
  await expect(memberApp.getByText("Paste rows to see them.")).toBeVisible();
  await expect(memberPage).toHaveURL(new RegExp(`${appPath}/data$`, "u"));
  await memberPage.goto(`${appPath}/data`);
  await expect(appIn(memberPage, "app-view").getByText("Paste rows to see them.")).toBeVisible();
  // Nobody is shown the address the frame is served from.
  await expect(memberPage.locator("body")).not.toContainText("app-content");
  // The draft is not the member's to see.
  await memberPage.goto(draftPathOf(appPath));
  await expect(memberPage.getByTestId("app-edit")).toContainText(
    "The draft of this app is not available to you."
  );
  // A write moves the draft ahead of what is published, with an outside host that nobody has
  // reviewed yet.
  const written = await requestWithOrigin(page, "put", `${apiOrigin}/api/v1/assets/app/${appId}`, {
    data: {
      workspaceId,
      expectedRevision: 1,
      files: Object.entries({
        ...pageSource(PUBLISHED_HEADING),
        "app.yaml": `id: ${appId}\nname: ${appName}\nkit: 1.0.0\nexternalHosts: [${HELD_HOST}]\n`,
        "src/routes/index.tsx": overviewRoute(DRAFT_HEADING)
      }).map(([path, text]) => ({ path, text }))
    },
    timeout: 90000
  });
  expect(written.ok(), await written.text()).toBe(true);
  // The member still opens what is published, with no way to the draft.
  await memberPage.goto(appsPath);
  await expect(memberCard.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
  await memberCard.getByRole("link", { name: `Open ${appName}`, exact: true }).click();
  await expect(
    appIn(memberPage, "app-view").getByRole("heading", { name: PUBLISHED_HEADING })
  ).toBeVisible();
  // A write on this App alone opens its editor, even without workspace build rights. The
  // workspace delete grant is denied on this App, so no Delete is offered.
  const person = apiOperations["me.get"].response.schema.parse(
    await (await memberPage.request.get(`${apiOrigin}/api/v1/me`)).json()
  );
  const asset = apiOperations["assets.get"].response.schema.parse(
    await (
      await page.request.get(`${apiOrigin}/api/v1/assets/app/${appId}?workspaceId=${workspaceId}`)
    ).json()
  );
  const grants: string[] = [];
  try {
    for (const [action, effect, scopeKind, scopeId] of [
      ["app.write", "allow", "asset", asset.id],
      ["app.delete", "allow", "workspace", workspaceId],
      ["app.delete", "deny", "asset", asset.id]
    ] as const) {
      const granted = await requestWithOrigin(
        page,
        "post",
        `${apiOrigin}/api/v1/instance/access/grants`,
        { data: { holderKind: "user", holderId: person.id, action, effect, scopeKind, scopeId } }
      );
      expect(granted.ok(), await granted.text()).toBe(true);
      grants.push(idSchema.parse(await granted.json()).id);
    }
    await memberPage.goto(appsPath);
    await expect(memberCard.getByRole("link", { name: "Edit", exact: true })).toBeVisible();
    await memberCard.getByRole("button", { name: `Actions for ${appName}` }).click();
    await expect(memberPage.getByRole("menuitem", { name: "Delete", exact: true })).toHaveCount(0);
    await memberPage.keyboard.press("Escape");
    await memberCard.getByRole("link", { name: "Edit", exact: true }).click();
    await expect(
      memberPage.getByTestId("app-edit").locator('[data-asset-status="draft"]')
    ).toHaveText("Draft · not live");
  } finally {
    for (const grantId of grants.reverse()) {
      const revoked = await requestWithOrigin(
        page,
        "delete",
        `${apiOrigin}/api/v1/instance/access/grants/${grantId}`
      );
      expect(revoked.ok()).toBe(true);
    }
  }
  await memberContext.close();
  // The draft shows the change, and the host it added is held back until it is published.
  await page.reload();
  await expect(edit.locator('[data-asset-status="draft"]')).toHaveText("Draft · not live");
  await expect(appIn(page, "app-edit").getByRole("heading", { name: DRAFT_HEADING })).toBeVisible();
  await expect(edit.getByRole("status").filter({ hasText: HELD_HOST })).toBeVisible();
  // Discard asks once, and the draft shows what is published again.
  await edit.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Discard", exact: true }).click();
  const discardDialog = page.getByRole("dialog", { name: `Discard the draft of “${appName}”?` });
  await discardDialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(discardDialog).toBeHidden();
  await expect(
    appIn(page, "app-edit").getByRole("heading", { name: PUBLISHED_HEADING })
  ).toBeVisible();
  await expect(edit.locator('[data-asset-status="draft"]')).toHaveCount(0);
  await expect(edit).not.toContainText(HELD_HOST);
});
