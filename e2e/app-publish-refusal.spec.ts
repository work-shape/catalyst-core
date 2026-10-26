import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { pageSource, pageSurface, savePage, writePageFiles } from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// REFUSE-1, Apps check 67 (browser half): a publish the instance refuses because the App
// needs a newer version of its Data Store reads as the interface's German sentence in the
// German interface, and the store it names is one click away beside it. Fails without the
// change: the dialog showed the instance's English sentence and no way to the store.

const TEST_TITLE = "a refused publish names the store in German, with the way to it";

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "app-publish-refused-below-store-level",
        reason:
          "Chromium's own log line: the test answers the App's publish with the refusal the " +
          "instance gives an App whose Data Store is below the level it needs, and asserts the " +
          "dialog's sentence and its way to the store.",
        matches: requestAnswered(409),
        path: /^\/api\/v1\/assets\/app\/[^/]+\/publish$/u,
        tests: [TEST_TITLE]
      }
    ]
  }
});

/** The person of this spec, from `tests/fixtures/e2e-users/app-publish-refusal.yaml`. */
const person = {
  email: "e2e-app-publish-refusal@example.test",
  password: "e2e-app-publish-refusal-password"
};

/** The store the refusal names. */
const STORE = "belege";

const idSchema = z.object({ id: z.string() });

async function signIn(page: Page): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
}

test(TEST_TITLE, async ({ page }, testInfo) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(30000);
  // An App's id is taken once for the whole instance: a repeated run names its own.
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  const appName = attempt === 0 ? "Belegprüfung" : `Belegprüfung ${attempt}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: "Buchhaltung" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;

  // The App's draft, from a Page built in a conversation of the workspace.
  await page.goto(`/w/${workspaceId}`);
  await writePageFiles(page, pageSource("Belege"));
  await savePage(page);
  const surface = pageSurface(page);
  await expect(surface).toBeVisible();
  await surface.getByRole("button", { name: /^(?:Save as app|Als App speichern)$/u }).click();
  const saveDialog = page.getByRole("dialog");
  await saveDialog.getByRole("textbox", { name: /^Name/u }).fill(appName);
  await saveDialog.getByRole("button", { name: /^(?:Save|Speichern)$/u }).click();
  await expect(page).toHaveURL(/\/app-drafts\/[^/]+$/u);

  // The instance refuses the publish as it does for an App whose store is below its level.
  await page.route("**/api/v1/assets/app/*/publish", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "CONFLICT",
          message: `The App needs the Data Store '${STORE}' at migration level 3 (minSchema) and the store is at level 2. Publish the App: its Publish carries the store's pending migrations.`,
          details: {
            reason: "data_store_below_min_schema",
            dataStore: STORE,
            minSchema: 3,
            level: 2
          }
        }
      }
    })
  );

  // The German interface.
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.reload();
  const edit = page.getByTestId("app-edit");
  await edit.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `„${appName}“ veröffentlichen?` });
  const send = dialog.getByRole("button", { name: "Veröffentlichen", exact: true });
  await expect(send).toBeEnabled();
  await send.click();

  const refusal = dialog.getByTestId("refusal-notice");
  await expect(refusal).toContainText(
    `Die App braucht den Datenspeicher „${STORE}“ in einer neueren Fassung. Veröffentliche ihn zusammen mit der App.`
  );
  await expect(refusal).not.toContainText(/minSchema|migration|level/iu);
  const toStore = refusal.getByRole("link", { name: "Datenspeicher öffnen", exact: true });
  // The way leads to the store's page in Build. It is not followed: no store of the name is
  // on the instance, and its page would be refused.
  await expect(toStore).toHaveAttribute("href", `/build/data-stores/${STORE}`);

  // Closed, the dialog leaves the refusal and its way to the store in the App's head.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const inHead = page.getByTestId("refusal-notice");
  await expect(inHead).toContainText(`Die App braucht den Datenspeicher „${STORE}“`);
  await expect(
    inHead.getByRole("link", { name: "Datenspeicher öffnen", exact: true })
  ).toHaveAttribute("href", `/build/data-stores/${STORE}`);
});
