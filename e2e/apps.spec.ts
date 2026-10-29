import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
// saved as an App, its draft is published, a second member opens it across the full width and
// follows a link to its second route, a builder without the publish right finds Publish held,
// and a discarded draft shows what is published again. Fails without S3-41: the rail has no
// Apps row and none of these addresses exists.
/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;
/** The three people of this spec, from `tests/fixtures/e2e-users/apps.yaml`. */
const admin = { email: "e2e-apps@example.test", password: "e2e-apps-password" };
const member = { email: "e2e-apps-member@example.test", password: "e2e-apps-member-password" };
const builder = { email: "e2e-apps-builder@example.test", password: "e2e-apps-builder-password" };
const WORKSPACE = "Sales team";
const PUBLISHED_HEADING = "Revenue overview";
const DRAFT_HEADING = "Revenue forecast";
/** The outside host the draft adds and the published revision does not list. */
const HELD_HOST = "rates.example.com";
const idSchema = z.object({ id: z.string() });
async function signIn(
  page: Page,
  person: {
    email: string;
    password: string;
  }
): Promise<void> {
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
type Variant = readonly [theme: "light" | "dark", locale: "en" | "de", width: 1440 | 390];
const WIDE: readonly Variant[] = [
  ["light", "en", 1440],
  ["dark", "en", 1440]
];
const MAIN: readonly Variant[] = [...WIDE, ["light", "en", 390], ["light", "de", 1440]];
/**
 * Pictures of the screen the page is on, once per variant. The language and the theme are read
 * when the interface loads, so each variant loads the address again and waits for `ready`.
 */
async function shoot(
  page: Page,
  name: string,
  _variants: readonly Variant[],
  ready: () => Promise<void>
): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  const show = async ([theme, locale, width]: Variant) => {
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
  {
    const variant: Variant = ["light", "en", 1440];
    await show(variant);
    await page.screenshot({
      path: join(shotsDir, `${name}-${variant.join("-")}.png`),
      animations: "disabled"
    });
  }
  await show(["light", "en", 1440]);
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
  test.setTimeout(shotsDir ? 600000 : 240000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, admin);
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 }
  });
  const builderContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 }
  });
  await pageErrors.watch(memberContext);
  await pageErrors.watch(builderContext);
  const memberPage = await memberContext.newPage();
  const builderPage = await builderContext.newPage();
  await signIn(memberPage, member);
  await signIn(builderPage, builder);
  // A click that finds nothing fails here and not at the end of the test.
  for (const each of [page, memberPage, builderPage]) {
    each.setDefaultTimeout(30000);
  }
  // The workspace of the spec and its two further members.
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: WORKSPACE }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  for (const person of [member, builder]) {
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/workspaces/${workspaceId}/members`,
      { data: { email: person.email } }
    );
    expect(added.ok()).toBe(true);
  }
  const appsPath = `/w/${workspaceId}/apps`;
  const appPath = `${appsPath}/${appId}`;
  // The rail has the Apps row, and the workspace has no App yet.
  await page.goto(`/w/${workspaceId}`);
  const rail = page.getByRole("navigation", { name: /^(?:Main navigation|Hauptnavigation)$/u });
  await expect(rail.getByText("Apps", { exact: true })).toBeVisible();
  await shoot(page, "rail-apps", WIDE, async () => {
    await expect(rail.getByText("Apps", { exact: true })).toBeVisible();
  });
  await rail.getByText("Apps", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${appsPath}$`, "u"));
  const area = page.getByTestId("apps-area");
  await expect(area).toContainText("No apps in this workspace yet.");
  await shoot(page, "apps-empty", MAIN, async () => {
    await expect(area).toContainText(/No apps in this workspace yet|noch keine Apps/u);
  });
  // The Page is built in a conversation of the workspace.
  await page.goto(`/w/${workspaceId}`);
  await writePageFiles(page, pageSource(PUBLISHED_HEADING));
  await savePage(page);
  const surface = pageSurface(page);
  await expect(surface).toBeVisible();
  // Save as app asks for a name and nothing else, and leads to the draft.
  const saveAsApp = surface.getByRole("button", { name: /^(?:Save as app|Als App speichern)$/u });
  const saveDialog = page.getByRole("dialog");
  await saveAsApp.click();
  await expect(saveDialog).toBeVisible();
  await shoot(page, "save-as-app", MAIN, async () => {
    // After a reload the conversation shows the Page's card, and the card opens it.
    await page
      .getByTestId("page-card")
      .getByRole("button", { name: /^(?:Open|Öffnen)$/u })
      .click();
    await expect(surface).toBeVisible();
    await saveAsApp.click();
    await expect(saveDialog).toBeVisible();
  });
  // A name, and no field for an id or a scope.
  await expect(saveDialog.getByRole("textbox")).toHaveCount(1);
  await saveDialog.getByRole("textbox", { name: /^Name/u }).fill(appName);
  await expect(saveDialog.getByRole("combobox")).toHaveCount(0);
  await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${draftPathOf(appPath)}$`, "u"));
  const edit = page.getByTestId("app-edit");
  await expect(edit).toContainText("Draft · not published");
  await expect(
    appIn(page, "app-edit").getByRole("heading", { name: PUBLISHED_HEADING })
  ).toBeVisible();
  // Publish asks once and names the revision the head shows.
  const publish = edit.getByRole("button", { name: "Publish", exact: true });
  await publish.click();
  await expect(edit.getByRole("heading", { name: appName })).toBeVisible();
  // The header of the conversation the App was saved from is no band over the App's head.
  await expect(page.locator("header[data-beside-surface]")).toHaveCount(0);
  const publishDialog = page.getByRole("dialog", { name: `Publish “${appName}”?` });
  // Others in the workspace use the App below: it is published for the workspace (SHARE-1).
  await chooseWorkspaceAudience(publishDialog);
  // The revision sentence stands behind Details since PUBQ-1.
  await publishDialog.getByRole("button", { name: "Details", exact: true }).click();
  await expect(publishDialog).toContainText(
    "Everyone in Sales team gets this state when they open the app."
  );
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await page.screenshot({
      path: join(shotsDir, "app-publish-dialog-light-en-1440.png"),
      animations: "disabled"
    });
  }
  await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publishDialog).toBeHidden();
  // The head says what was published, not that a draft is open (ACCEPT-FIX-2 C5).
  await expect(edit).toContainText("Live: version 1 · since");
  await expect(edit).not.toContainText("Draft: changed since");
  if (shotsDir) {
    await page.screenshot({
      path: join(shotsDir, "app-published-head-light-en-1440.png"),
      animations: "disabled"
    });
  }
  // The live revision can still be shared with a different audience.
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(publishDialog).toBeVisible();
  await expect(publishDialog.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await publishDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  // A second member of the workspace opens the App across the full width.
  // The member holds the use right alone, through membership: the list shows the published App
  // under its title, and the App opens from there.
  await memberPage.goto(appsPath);
  const memberArea = memberPage.getByTestId("apps-area");
  await expect(memberArea).toContainText(appName);
  await memberArea.getByRole("link", { name: `Open ${appName}`, exact: true }).click();
  await expect(memberPage).toHaveURL(new RegExp(`${appPath}$`, "u"));
  const memberView = memberPage.getByTestId("app-view");
  const memberApp = appIn(memberPage, "app-view");
  await expect(memberApp.getByRole("heading", { name: PUBLISHED_HEADING })).toBeVisible();
  await expect(memberView.getByRole("heading", { name: appName })).toBeVisible();
  await expect(
    memberPage
      .getByRole("navigation", { name: "Main navigation" })
      .getByText("Apps", { exact: true })
  ).toBeVisible();
  // The App's own route becomes part of the address, and the address opens that route cold.
  await memberApp.getByText("Data", { exact: true }).click();
  await expect(memberApp.getByText("Paste rows to see them.")).toBeVisible();
  await expect(memberPage).toHaveURL(new RegExp(`${appPath}/data$`, "u"));
  await memberPage.goto(`${appPath}/data`);
  await expect(appIn(memberPage, "app-view").getByText("Paste rows to see them.")).toBeVisible();
  // Nobody is shown the address the frame is served from.
  await expect(memberPage.locator("body")).not.toContainText("app-content");
  await shoot(memberPage, "app-view-member-route", [["light", "en", 1440]], async () => {
    await expect(appIn(memberPage, "app-view").getByText("Paste rows to see them.")).toBeVisible();
  });
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
  // The member is shown nothing of the draft: the list names what is published and no change
  // waiting, and the open App has no way to a draft.
  await memberPage.goto(appsPath);
  const memberListReady = async () => {
    await expect(memberArea.getByText(appName, { exact: true })).toBeVisible();
  };
  await memberListReady();
  await expect(memberArea).toContainText(appName);
  await expect(memberArea).not.toContainText("Draft: changed");
  // The App is a card with one main action. The id and the way to the draft are a builder's,
  // and the menu holds what a member does beside opening.
  const memberCard = memberArea.getByRole("listitem").filter({ hasText: appName });
  // Open is named with the App it opens.
  const memberOpen = memberCard.getByRole("link", { name: `Open ${appName}`, exact: true });
  await expect(memberOpen).toHaveAttribute("href", appPath);
  // The time stands above the card's Open, so the pointer meets it and its full date shows.
  const changed = memberCard.locator("time");
  await expect(changed).toHaveAttribute("title", /\d/u);
  expect(
    await changed.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
    })
  ).toBe(true);
  await expect(memberCard.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(memberCard).not.toContainText(appId);
  // The menu stands above the card that opens the App, and opens itself.
  await memberCard.getByRole("button", { name: `Actions for ${appName}` }).click();
  await expect(memberPage.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(memberPage.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
  await memberPage.keyboard.press("Escape");
  await shoot(memberPage, "apps-list-member", [["light", "en", 1440]], memberListReady);
  // The whole card opens the App: a click on its name lands on Open, whose area lies over it.
  await memberCard.getByRole("heading", { name: appName, exact: true }).click({ force: true });
  await expect(
    appIn(memberPage, "app-view").getByRole("heading", { name: PUBLISHED_HEADING })
  ).toBeVisible();
  await expect(memberView.getByRole("heading", { name: appName })).toBeVisible();
  await expect(memberView.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await shoot(memberPage, "app-view-member", [["light", "en", 1440]], async () => {
    await expect(
      appIn(memberPage, "app-view").getByRole("heading", { name: PUBLISHED_HEADING })
    ).toBeVisible();
    await expect(memberView.getByRole("heading", { name: appName })).toBeVisible();
  });
  // A write on this App alone opens its editor, even without workspace build rights.
  // The workspace delete grant is explicitly denied on this App, so no Delete is offered.
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
        {
          data: { holderKind: "user", holderId: person.id, action, effect, scopeKind, scopeId }
        }
      );
      expect(granted.ok(), await granted.text()).toBe(true);
      grants.push(idSchema.parse(await granted.json()).id);
    }
    await memberPage.goto(appsPath);
    await expect(memberCard.getByRole("link", { name: "Edit", exact: true })).toBeVisible();
    await memberCard.getByRole("button", { name: `Actions for ${appName}` }).click();
    await expect(memberPage.getByRole("menuitem", { name: "Delete", exact: true })).toHaveCount(0);
    await memberPage.keyboard.press("Escape");
    await expect(memberPage.getByRole("menu")).toBeHidden();
    await shoot(
      memberPage,
      "apps-list-asset-write-delete-denied",
      [
        ["light", "en", 1440],
        ["dark", "en", 1440],
        ["light", "de", 1440],
        ["dark", "de", 1440],
        ["light", "en", 390],
        ["dark", "en", 390],
        ["light", "de", 390],
        ["dark", "de", 390]
      ],
      async () => {
        await expect(
          memberCard.getByRole("link", { name: /^(?:Edit|Bearbeiten)$/u })
        ).toBeVisible();
        await memberCard.getByRole("button").click();
        await expect(memberPage.getByRole("menu")).toBeVisible();
        await expect(
          memberPage.getByRole("menuitem", { name: /^(?:Delete|Löschen)$/u })
        ).toHaveCount(0);
      }
    );
    if (shotsDir) {
      await memberPage.keyboard.press("Escape");
      await expect(memberPage.getByRole("menu")).toBeHidden();
    }
    await memberCard.getByRole("link", { name: "Edit", exact: true }).click();
    const memberEdit = memberPage.getByTestId("app-edit");
    await expect(memberEdit).toContainText("Draft: changed since version 1");
    // The conversation subject keeps the server's separate read requirement. The editor
    // above needs write alone; grant read on this App too before starting its conversation.
    const readable = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: person.id,
          action: "app.read",
          effect: "allow",
          scopeKind: "asset",
          scopeId: asset.id
        }
      }
    );
    expect(readable.ok(), await readable.text()).toBe(true);
    grants.push(idSchema.parse(await readable.json()).id);
    await memberPage.reload();
    await expect(memberEdit).toContainText("Draft: changed since version 1");
    await memberPage.getByTestId("dock-page-action").click();
    await expect(memberPage).toHaveURL(
      (url) => url.pathname === draftPathOf(appPath) && url.searchParams.has("chat")
    );
    await expect(memberPage.getByTestId("dock-head")).toHaveAttribute("data-subject-kind", "app");
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
  await page.reload();
  const draftReady = async () => {
    await expect(edit).toContainText(
      /(?:Draft: changed since version|Entwurf: geändert seit Version) 1/u
    );
    await expect(
      appIn(page, "app-edit").getByRole("heading", { name: DRAFT_HEADING })
    ).toBeVisible();
    // The host the draft added is held back until the draft is published.
    await expect(edit.getByRole("status").filter({ hasText: HELD_HOST })).toBeVisible();
  };
  await draftReady();
  await expect(edit).toContainText(`This draft cannot call ${HELD_HOST} until it is published.`);
  await expect(publish).toBeEnabled();
  const discard = edit.getByRole("button", { name: "Discard", exact: true });
  await expect(discard).toBeVisible();
  await shoot(page, "app-draft", MAIN, draftReady);
  // Files and Actions fold under Technical details: folded on the first visit, open after a
  // click, and still open after a reload, as this browser remembers.
  const details = edit.getByRole("button", { name: "Technical details", exact: true });
  const filesTab = edit.getByRole("tab", { name: "Files" });
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(edit.getByRole("tab")).toHaveText(["Preview"]);
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(edit.getByRole("tab")).toHaveText(["Preview", "Files", "Actions"]);
  await page.reload();
  await draftReady();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(filesTab).toBeVisible();
  // The files of the draft, with the one the draft changed marked and open.
  await filesTab.click();
  await expect(edit.getByRole("navigation", { name: "Files" })).toContainText(
    "src/routes/data.tsx"
  );
  await expect(edit).toContainText("Changed");
  await expect(edit).toContainText(DRAFT_HEADING);
  if (shotsDir) {
    await page.screenshot({
      path: join(shotsDir, "app-draft-files-light-en-1440.png"),
      animations: "disabled"
    });
  }
  await edit.getByRole("tab", { name: "Preview" }).click();
  // The history of the App: its versions, with the saves after each folded under it and the
  // way to publish one of them.
  const openRevisions = async () => {
    await edit.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "History" }).click();
  };
  const revisions = page.getByRole("dialog", { name: "History" });
  // Escape closes the drawer at once, while the menu it was opened from is still closing and
  // still listens for the key.
  await openRevisions();
  await expect(revisions).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(revisions).toBeHidden();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await openRevisions();
  await expect(revisions).toContainText("Version 1");
  // The newest version's saves: the draft written since it was published.
  await revisions
    .getByRole("button", { name: /^\d+ draft saves?$/u })
    .first()
    .click();
  await expect(revisions.getByRole("button", { name: "Publish this save" })).toBeVisible();
  if (shotsDir) {
    await page.screenshot({
      path: join(shotsDir, "app-revisions-light-en-1440.png"),
      animations: "disabled"
    });
  }
  // Escape closes the drawer, as it closes every dialog.
  await page.keyboard.press("Escape");
  await expect(revisions).toBeHidden();
  // A builder who may write and not publish finds Publish held, with the right named. The
  // instance's answers to this builder, in this workspace and for this App, are passed on
  // without the publish right, as a grant of write without publish answers them.
  const contextOperation = apiOperations["platform.context.get"];
  await builderPage.route(
    (url) => url.origin === apiOrigin && url.pathname === contextOperation.path,
    async (route) => {
      const answer = await route.fetch();
      const context = contextOperation.response.schema.parse(await answer.json());
      await route.fulfill({
        response: answer,
        json: {
          ...context,
          actions: context.actions.filter((action) => action !== "app.publish"),
          workspaces: context.workspaces.map((each) =>
            each.id === workspaceId
              ? { ...each, actions: each.actions.filter((action) => action !== "app.publish") }
              : each
          )
        }
      });
    }
  );
  const assetOperation = apiOperations["assets.get"];
  const assetPath = assetOperation.path.replace(":kind", "app").replace(":name", appId);
  await builderPage.route(
    (url) => url.origin === apiOrigin && url.pathname === assetPath,
    async (route) => {
      if (route.request().method() !== assetOperation.method) {
        await route.continue();
        return;
      }
      const answer = await route.fetch();
      const asset = assetOperation.response.schema.parse(await answer.json());
      await route.fulfill({
        response: answer,
        json: { ...asset, allowed: asset.allowed?.filter((verb) => verb !== "publish") }
      });
    }
  );
  await builderPage.goto(draftPathOf(appPath));
  const builderEdit = builderPage.getByTestId("app-edit");
  await expect(builderEdit).toContainText("Draft: changed since version 1");
  await expect(builderEdit.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await expect(builderEdit).toContainText("You need the right “app.publish” to publish.");
  await shoot(builderPage, "app-draft-no-publish", [["light", "en", 1440]], async () => {
    await expect(builderEdit).toContainText("You need the right “app.publish” to publish.");
    await expect(
      appIn(builderPage, "app-edit").getByRole("heading", { name: DRAFT_HEADING })
    ).toBeVisible();
  });
  await builderContext.close();
  // The page shows the App with its state, and opens it.
  await page.goto(appsPath);
  await expect(area).toContainText(appName);
  await shoot(page, "apps-list", MAIN, async () => {
    await expect(area).toContainText(appName);
  });
  // The builder's card opens the App and leads to its draft beside that.
  const card = area.getByRole("listitem").filter({ hasText: appName });
  await expect(card.getByRole("link", { name: "Edit", exact: true })).toHaveAttribute(
    "href",
    draftPathOf(appPath)
  );
  await card.getByRole("link", { name: `Open ${appName}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${appPath}$`, "u"));
  const viewReady = async () => {
    await expect(
      appIn(page, "app-view").getByRole("heading", { name: PUBLISHED_HEADING })
    ).toBeVisible();
  };
  await viewReady();
  await shoot(page, "app-view", MAIN, viewReady);
  // Copy link puts the App's address on the clipboard and says so in place for a moment.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("app-view").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  await expect(page.getByRole("menuitem", { name: "Link copied" })).toBeVisible();
  if (shotsDir) {
    await page.screenshot({
      path: join(shotsDir, "app-link-copied-light-en-1440.png"),
      animations: "disabled"
    });
  }
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${uiOrigin}${appPath}`);
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  // Discard asks once, and the draft shows what is published again.
  await page.goto(draftPathOf(appPath));
  await draftReady();
  await discard.click();
  const discardDialog = page.getByRole("dialog", { name: `Discard the draft of “${appName}”?` });
  await expect(discardDialog).toContainText("The draft goes back to what is live.");
  await discardDialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(discardDialog).toBeHidden();
  await expect(
    appIn(page, "app-edit").getByRole("heading", { name: PUBLISHED_HEADING })
  ).toBeVisible();
  await expect(discard).toBeHidden();
  await expect(edit).not.toContainText(HELD_HOST);
  // T34: a builder renames the App where its name stands, on its page and on its card. Only the
  // name people read changes, at once for what is published: the address stays, and no draft
  // waits to be published.
  const newName = attempt === 0 ? "Revenue dashboard" : `Revenue dashboard ${attempt}`;
  const view = page.getByTestId("app-view");
  const nameField = page.getByRole("textbox", { name: "App name", exact: true });
  const renameFromHead = async () => {
    await view.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await expect(nameField).toBeFocused();
  };
  await page.goto(appPath);
  await viewReady();
  // Escape leaves the name as it was.
  await renameFromHead();
  await expect(nameField).toHaveValue(appName);
  await page.keyboard.press("Escape");
  await expect(nameField).toBeHidden();
  await expect(view.getByRole("heading", { name: appName })).toBeVisible();
  await renameFromHead();
  await nameField.fill(newName);
  if (shotsDir) {
    await page.screenshot({
      path: join(shotsDir, "app-rename-head-light-en-1440.png"),
      animations: "disabled"
    });
  }
  await nameField.press("Enter");
  await expect(nameField).toBeHidden();
  await expect(view.getByRole("heading", { name: newName })).toBeVisible();
  await expect(view.getByRole("heading", { name: newName })).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`${appPath}$`, "u"));
  // The draft has the same name, and nothing waits to be published.
  await page.goto(draftPathOf(appPath));
  await expect(edit.getByRole("heading", { name: newName })).toBeVisible();
  await expect(edit).toContainText("Live: version 1 · since");
  await expect(edit).not.toContainText("Draft: changed since");
  // On its card: the menu's Rename puts the field in the name's place, Enter saves it, and the
  // focus goes back to the card's menu.
  await page.goto(appsPath);
  const renamedCard = area.getByRole("listitem").filter({ hasText: newName });
  await expect(
    renamedCard.getByRole("link", { name: `Open ${newName}`, exact: true })
  ).toHaveAttribute("href", appPath);
  await renamedCard.getByRole("button", { name: `Actions for ${newName}` }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await expect(nameField).toBeFocused();
  await expect(nameField).toHaveValue(newName);
  await nameField.fill(appName);
  if (shotsDir) {
    await page.screenshot({
      path: join(shotsDir, "apps-list-rename-light-en-1440.png"),
      animations: "disabled"
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(nameField).toBeVisible();
    await page.screenshot({
      path: join(shotsDir, "apps-list-rename-light-en-390.png"),
      animations: "disabled"
    });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await nameField.press("Enter");
  await expect(nameField).toBeHidden();
  await expect(
    area
      .getByRole("listitem")
      .filter({ hasText: appName })
      .getByRole("link", { name: `Open ${appName}`, exact: true })
  ).toHaveAttribute("href", appPath);
  await expect(area.getByRole("button", { name: `Actions for ${appName}` })).toBeFocused();
});
