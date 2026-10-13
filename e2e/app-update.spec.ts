import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { z } from "zod";
import {
  builtPage,
  overviewRoute,
  pageSource,
  pageSurface,
  patchThatAdds,
  rewritePageFile,
  savePage,
  writePageFiles
} from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// A Page that was saved as an App takes its later revisions into that App: the header of the
// Page offers Update app in place of Save as app, the update becomes the next draft revision
// and publishes nothing, a draft that was written somewhere else is replaced only by a button
// that says so, and a Page whose App was deleted offers Save as app again. The second walk is
// the App from before Apps remembered their Page: Save as app under its id offers to update
// it from the Page, and the Page is that App's from then on. Fails without Update app: the
// header offers Save as app, and saving answers that the id is taken.

/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;

/** The person of this spec, from `tests/fixtures/e2e-app.yaml`. */
const admin = { email: "e2e-app-update@example.test", password: "e2e-app-update-password" };

const WORKSPACE = "Offers team";
const FIRST_HEADING = "Offer calculator";
const THIRD_HEADING = "Offer calculator with discounts";
const ELSEWHERE_HEADING = "Written with the API";
const FOURTH_HEADING = "Offer calculator with discounts and tax";

const idSchema = z.object({ id: z.string() });
const assetSchema = z.looseObject({
  draftRevision: z.number(),
  publishedRevision: z.number().optional()
});

type Variant = readonly [theme: "light" | "dark", locale: "en" | "de", width: 1440 | 390];
const BOTH: readonly Variant[] = [
  ["light", "en", 1440],
  ["dark", "en", 1440]
];
const ALL: readonly Variant[] = [...BOTH, ["light", "en", 390], ["light", "de", 1440]];

/** The App inside the frame of the screen with this test id. */
function appIn(page: Page, screen: "app-view" | "app-edit"): FrameLocator {
  return page
    .getByTestId(screen)
    .getByTestId("page-preview-frame")
    .contentFrame()
    .frameLocator("iframe");
}

/**
 * Pictures of the screen the page is on, once per variant. The language and the theme are read
 * when the interface loads, so each variant loads the address again and waits for `ready`.
 */
async function shoot(
  page: Page,
  name: string,
  variants: readonly Variant[],
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
  for (const variant of variants) {
    await show(variant);
    await page.screenshot({
      path: join(shotsDir, `${name}-${variant.join("-")}.png`),
      animations: "disabled"
    });
  }
  await show(["light", "en", 1440]);
}

test("a Page saved as an App updates the draft of that App, and nothing that is published", async ({
  page
}, testInfo) => {
  // An App's id is taken once for the whole instance, so a repeated or retried run on the same
  // instance names its App after the attempt.
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  const appName = attempt === 0 ? "Offer calculator" : `Offer calculator ${attempt}`;
  const appId = attempt === 0 ? "offer-calculator" : `offer-calculator-${attempt}`;
  test.setTimeout(shotsDir ? 600_000 : 300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(30_000);
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);

  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: WORKSPACE }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const appPath = `/w/${workspaceId}/apps/${appId}`;
  const assetUrl = `${apiOrigin}/api/v1/assets/app/${appId}`;
  const asset = async () =>
    assetSchema.parse(
      await (await page.request.get(`${assetUrl}?workspaceId=${workspaceId}`)).json()
    );

  const surface = pageSurface(page);
  const saveAsApp = surface.getByRole("button", { name: /^(?:Save as app|Als App speichern)$/u });
  const updateApp = surface.getByRole("button", { name: /^(?:Update app|App aktualisieren)$/u });
  const dialog = page.getByRole("dialog");
  /** After a reload the conversation shows the Page's cards, and the last one opens it. */
  const openSurface = async () => {
    await page
      .getByTestId("page-card")
      .last()
      .getByRole("button", { name: /^(?:Open|Öffnen)$/u })
      .click();
    await expect(surface).toBeVisible();
    await expect(builtPage(page).getByRole("heading")).toBeVisible();
  };

  // The Page is built in a conversation of the workspace. Its header offers Save as app.
  await page.goto(`/w/${workspaceId}`);
  await writePageFiles(page, patchThatAdds(pageSource(FIRST_HEADING)));
  await savePage(page);
  await expect(surface).toContainText("Revision 1");
  await expect(saveAsApp).toBeVisible();
  await expect(updateApp).toHaveCount(0);
  const conversationUrl = page.url();
  await shoot(page, "page-save-as-app", BOTH, async () => {
    await openSurface();
    await expect(saveAsApp).toBeVisible();
  });

  // It is saved as an App, and revision 1 is published.
  await saveAsApp.click();
  await dialog.getByRole("textbox", { name: /^Name/u }).fill(appName);
  await expect(dialog.getByRole("textbox", { name: /^ID/u })).toHaveValue(appId);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${appPath}/edit$`, "u"));
  const edit = page.getByTestId("app-edit");
  await expect(edit).toContainText("Draft · revision 1");
  await edit.getByRole("button", { name: "Publish", exact: true }).click();
  const publishDialog = page.getByRole("dialog", { name: `Publish “${appName}”?` });
  await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publishDialog).toBeHidden();

  // Changes are asked for in the conversation: the Page comes to revision 3.
  await page.goto(conversationUrl);
  await openSurface();
  await rewritePageFile(page, "src/routes/index.tsx", overviewRoute("Offer calculator, wider"));
  await savePage(page);
  await expect(surface).toContainText("Revision 2");
  await rewritePageFile(page, "src/routes/index.tsx", overviewRoute(THIRD_HEADING));
  await savePage(page);
  await expect(surface).toContainText("Revision 3");

  // The header offers the update of the App, and Save as app no more.
  await expect(updateApp).toBeVisible();
  await expect(saveAsApp).toHaveCount(0);
  await shoot(page, "page-update-app", ALL, async () => {
    await openSurface();
    await expect(updateApp).toBeVisible();
  });

  // The update names the App and says that nothing is published by it.
  await updateApp.click();
  const asked = page.getByRole("dialog", { name: `Update “${appName}”?` });
  await expect(asked).toContainText(
    "The page as it is now becomes the draft of this app. People who use the app see the change only once the draft is published."
  );
  await shoot(page, "update-app-dialog", ALL, async () => {
    await openSurface();
    await updateApp.click();
    await expect(dialog).toBeVisible();
  });
  await asked.getByRole("button", { name: "Update draft", exact: true }).click();
  const done = page.getByRole("dialog", { name: `The draft of “${appName}” is updated` });
  await expect(done).toContainText("Open the draft to check and publish it.");
  if (shotsDir) {
    await page.screenshot({
      path: join(shotsDir, "update-app-done-light-en-1440.png"),
      animations: "disabled"
    });
  }
  expect(await asset()).toMatchObject({ draftRevision: 2, publishedRevision: 1 });

  // The confirmation leads to the App: its draft is revision 2 with the Page as it is now.
  await done.getByRole("button", { name: "Open the draft", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${appPath}/edit$`, "u"));
  const draftReady = async () => {
    await expect(edit).toContainText(/(?:Draft · revision|Entwurf · Revision) 2/u);
    await expect(
      appIn(page, "app-edit").getByRole("heading", { name: THIRD_HEADING })
    ).toBeVisible();
  };
  await draftReady();
  await shoot(page, "app-draft-after-update", BOTH, draftReady);
  // Whoever uses the App is shown what was published, as before.
  await page.goto(appPath);
  await expect(appIn(page, "app-view").getByRole("heading", { name: FIRST_HEADING })).toBeVisible();

  // The revisions of the App publish the new one, as they did.
  await page.goto(`${appPath}/edit`);
  await draftReady();
  await edit.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Revisions" }).click();
  const revisions = page.getByRole("dialog", { name: "Revisions" });
  await revisions.getByRole("button", { name: "Publish this revision" }).first().click();
  const publishSecond = page.getByRole("dialog", { name: `Publish “${appName}”?` });
  await publishSecond.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publishSecond).toBeHidden();
  expect(await asset()).toMatchObject({ draftRevision: 2, publishedRevision: 2 });
  await page.goto(appPath);
  await expect(appIn(page, "app-view").getByRole("heading", { name: THIRD_HEADING })).toBeVisible();

  // The Page changes once more, and its reader asks for the update.
  await page.goto(conversationUrl);
  await openSurface();
  await rewritePageFile(page, "src/routes/index.tsx", overviewRoute(FOURTH_HEADING));
  await savePage(page);
  await expect(surface).toContainText("Revision 4");
  await updateApp.click();
  await expect(asked.getByRole("button", { name: "Update draft", exact: true })).toBeVisible();

  // Meanwhile the draft is written somewhere else.
  const written = await requestWithOrigin(page, "put", assetUrl, {
    data: {
      workspaceId,
      expectedRevision: 2,
      files: Object.entries({
        ...pageSource(FIRST_HEADING),
        "app.yaml": `id: ${appId}\nname: ${appName}\nkit: 1.0.0\n`,
        "src/routes/index.tsx": overviewRoute(ELSEWHERE_HEADING)
      }).map(([path, text]) => ({ path, text }))
    },
    timeout: 90_000
  });
  expect(written.ok(), await written.text()).toBe(true);

  // The update is not made over it: the reader is told, and the button says what it does now.
  await asked.getByRole("button", { name: "Update draft", exact: true }).click();
  const replace = asked.getByRole("button", { name: "Replace draft", exact: true });
  await expect(replace).toBeVisible();
  await expect(asked).toContainText(
    "The draft of this app was changed somewhere else since it was last updated from this page. Updating replaces those changes."
  );
  expect(await asset()).toMatchObject({ draftRevision: 3 });
  // Asked again later, the Page still says so before anything is written.
  await asked.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(asked).toBeHidden();
  await updateApp.click();
  await expect(replace).toBeVisible();
  await expect(asked.getByRole("button", { name: "Update draft", exact: true })).toHaveCount(0);
  await shoot(page, "update-app-changed-elsewhere", ALL, async () => {
    await openSurface();
    await updateApp.click();
    await expect(dialog).toBeVisible();
  });
  await replace.click();
  await expect(done).toBeVisible();
  expect(await asset()).toMatchObject({ draftRevision: 4, publishedRevision: 2 });
  await done.getByRole("button", { name: "Open the draft", exact: true }).click();
  await expect(edit).toContainText("Draft · revision 4");
  await expect(
    appIn(page, "app-edit").getByRole("heading", { name: FOURTH_HEADING })
  ).toBeVisible();

  // Without its App the Page is one that can be saved as an App again.
  const deleted = await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
    data: { workspaceId, expectedRevision: 4 }
  });
  expect(deleted.ok(), await deleted.text()).toBe(true);
  await page.goto(conversationUrl);
  await openSurface();
  await expect(saveAsApp).toBeVisible();
  await expect(updateApp).toHaveCount(0);
});

test("a Page is put into an App that was saved before Apps remembered their Page", async ({
  page
}, testInfo) => {
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  const appName = attempt === 0 ? "Offer sheet" : `Offer sheet ${attempt}`;
  const appId = attempt === 0 ? "offer-sheet" : `offer-sheet-${attempt}`;
  test.setTimeout(shotsDir ? 600_000 : 300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(30_000);
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: "Sheets team" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const appPath = `/w/${workspaceId}/apps/${appId}`;
  const assetUrl = `${apiOrigin}/api/v1/assets/app/${appId}`;
  const asset = async () =>
    assetSchema.parse(
      await (await page.request.get(`${assetUrl}?workspaceId=${workspaceId}`)).json()
    );

  // The App as an earlier release left it: written and published, and no Page named by it.
  const written = await requestWithOrigin(page, "put", assetUrl, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: Object.entries({
        ...pageSource(FIRST_HEADING),
        "app.yaml": `id: ${appId}\nname: ${appName}\nkit: 1.0.0\n`
      }).map(([path, text]) => ({ path, text }))
    },
    timeout: 90_000
  });
  expect(written.ok(), await written.text()).toBe(true);
  const published = await requestWithOrigin(page, "post", `${assetUrl}/publish`, {
    data: { workspaceId, revision: 1 }
  });
  expect(published.ok(), await published.text()).toBe(true);

  // Changes were asked for in the conversation since: the Page stands at revision 3.
  const surface = pageSurface(page);
  const saveAsApp = surface.getByRole("button", { name: /^(?:Save as app|Als App speichern)$/u });
  const updateApp = surface.getByRole("button", { name: /^(?:Update app|App aktualisieren)$/u });
  const dialog = page.getByRole("dialog");
  await page.goto(`/w/${workspaceId}`);
  await writePageFiles(page, patchThatAdds(pageSource(FIRST_HEADING)));
  await savePage(page);
  await rewritePageFile(page, "src/routes/index.tsx", overviewRoute("Offer sheet, wider"));
  await savePage(page);
  await rewritePageFile(page, "src/routes/index.tsx", overviewRoute(THIRD_HEADING));
  await savePage(page);
  await expect(surface).toContainText("Revision 3");
  await expect(saveAsApp).toBeVisible();
  await expect(updateApp).toHaveCount(0);

  // Saving under the App's id is refused, and the dialog offers the App itself.
  const offer = dialog.getByRole("button", {
    name: new RegExp(
      `^(?:Update “${appName}” from this page|„${appName}“ aus dieser Page aktualisieren)$`,
      "u"
    )
  });
  const untilOffered = async () => {
    await saveAsApp.click();
    await dialog.getByRole("textbox", { name: /^Name/u }).fill(appName);
    await expect(dialog.getByRole("textbox", { name: /^ID/u })).toHaveValue(appId);
    await dialog.getByRole("button", { name: /^(?:Save|Speichern)$/u }).click();
    await expect(offer).toBeVisible();
  };
  const reopened = async () => {
    await page
      .getByTestId("page-card")
      .last()
      .getByRole("button", { name: /^(?:Open|Öffnen)$/u })
      .click();
    await expect(builtPage(page).getByRole("heading")).toBeVisible();
  };
  await untilOffered();
  await expect(dialog).toContainText(
    `The app “${appName}” already has this ID. Choose another ID to save a new app, or update that app from this page.`
  );
  await shoot(page, "save-as-app-id-taken", ALL, async () => {
    await reopened();
    await untilOffered();
  });
  // On a low window the offer and the footer are still reached.
  await page.setViewportSize({ width: 1440, height: 640 });
  await offer.scrollIntoViewIfNeeded();
  await expect(offer).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  if (shotsDir) {
    await page.screenshot({
      path: join(shotsDir, "save-as-app-id-taken-light-en-1440x640.png"),
      animations: "disabled"
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // The offer says what it replaces and what stays, before anything is written.
  await offer.click();
  const asked = page.getByRole("dialog", { name: `Update “${appName}” from this page?` });
  const replace = asked.getByRole("button", { name: "Replace draft", exact: true });
  await expect(asked).toContainText(
    "The current draft of this app is replaced by this page as it is now. The published version does not change until someone publishes the draft."
  );
  expect(await asset()).toMatchObject({ draftRevision: 1, publishedRevision: 1 });
  await shoot(page, "link-app-dialog", ALL, async () => {
    await reopened();
    await untilOffered();
    await offer.click();
    await expect(
      dialog.getByRole("button", { name: /^(?:Replace draft|Entwurf ersetzen)$/u })
    ).toBeInViewport();
  });
  // On a low window the footer is still reached.
  await page.setViewportSize({ width: 1440, height: 640 });
  await expect(replace).toBeInViewport();
  await expect(asked.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
  if (shotsDir) {
    await page.screenshot({
      path: join(shotsDir, "link-app-dialog-light-en-1440x640.png"),
      animations: "disabled"
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await replace.click();
  const done = page.getByRole("dialog", { name: `The draft of “${appName}” is updated` });
  await expect(done).toContainText(
    `The app keeps its name “${appName}”. The page is called “Revenue”.`
  );
  if (shotsDir) {
    await page.screenshot({
      path: join(shotsDir, "link-app-done-light-en-1440.png"),
      animations: "disabled"
    });
  }
  // The header under the confirmation is the one of a Page with an App.
  await expect(updateApp).toBeVisible();
  await expect(saveAsApp).toHaveCount(0);
  expect(await asset()).toMatchObject({ draftRevision: 2, publishedRevision: 1 });

  // The new draft is the Page as it is; what is published is what it was, until it is published.
  await done.getByRole("button", { name: "Open the draft", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${appPath}/edit$`, "u"));
  const edit = page.getByTestId("app-edit");
  await expect(edit).toContainText("Draft · revision 2");
  await expect(appIn(page, "app-edit").getByRole("heading", { name: THIRD_HEADING })).toBeVisible();
  await page.goto(appPath);
  await expect(appIn(page, "app-view").getByRole("heading", { name: FIRST_HEADING })).toBeVisible();
  await page.goto(`${appPath}/edit`);
  await edit.getByRole("button", { name: "Publish", exact: true }).click();
  const publishDialog = page.getByRole("dialog", { name: `Publish “${appName}”?` });
  await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publishDialog).toBeHidden();
  expect(await asset()).toMatchObject({ draftRevision: 2, publishedRevision: 2 });
  await page.goto(appPath);
  await expect(appIn(page, "app-view").getByRole("heading", { name: THIRD_HEADING })).toBeVisible();
});
