import type { Locator, Page, TestInfo } from "@playwright/test";
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

/** An App's id is taken once for the whole instance: a repeated run names its own. */
function appNameOf(base: string, testInfo: TestInfo): string {
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  return attempt === 0 ? base : `${base} ${attempt}`;
}

/**
 * Signs in, builds a Page in a new workspace, saves it as an App named `appName` and answers
 * the address of its draft page, which is open then.
 */
async function appDraft(page: Page, appName: string): Promise<string> {
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
  return new URL(page.url()).pathname;
}

test(TEST_TITLE, async ({ page }, testInfo) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(30000);
  const appName = appNameOf("Belegprüfung", testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await appDraft(page, appName);

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

// REFUSE-1 with GOLIVE-1: a store the Publish carries, whose draft stays below the level the
// App needs, is refused in the review's "Published with it" list. The refusal and its way to
// the store stay inside the dialog in both languages, on a phone and a desktop, in both
// themes. Fails without the stacked list: beside its label the notice ran past the dialog.
test("a store refused in the publish review stays inside the dialog with its way to the store", async ({
  page
}, testInfo) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(30000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const draft = await appDraft(page, appNameOf("Belegübersicht", testInfo));

  // The review names the store as the instance does for a draft below the App's level.
  await page.route("**/api/v1/apps/*/publish-review", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const review = z.record(z.string(), z.unknown()).parse(await response.json());
    await route.fulfill({
      response,
      json: {
        ...review,
        ready: false,
        publishesTogether: true,
        dataStores: [
          {
            name: STORE,
            title: "Belege",
            draftRevision: 2,
            publishedRevision: 1,
            pending: true,
            liveLevel: 1,
            minSchema: 3,
            pendingMigrations: ["Add receipt status"],
            refusals: [
              {
                reason: "data_store_draft_below_min_schema",
                message: "The App needs the Data Store 'belege' at migration level 3."
              }
            ]
          }
        ]
      }
    });
  });

  const sentences = {
    de: "Die App braucht eine neuere Fassung des Datenspeichers „Belege“, als sein Entwurf hat. Bitte den Agenten, den Datenspeicher zu ergänzen.",
    en: "The app needs a newer version of the data store “Belege” than its draft has. Ask the agent to extend the data store."
  };
  const views = [
    { locale: "de", width: 390, theme: "light" },
    { locale: "de", width: 1440, theme: "dark" },
    { locale: "en", width: 390, theme: "dark" },
    { locale: "en", width: 1440, theme: "light" }
  ] as const;
  for (const { locale, width, theme } of views) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      ([chosenLocale, chosenTheme]) => {
        window.localStorage.setItem("vivd-catalyst:locale", chosenLocale);
        window.localStorage.setItem("vivd-catalyst:theme", chosenTheme);
      },
      [locale, theme] as const
    );
    await page.goto(draft);
    const publish = /^(?:Publish|Veröffentlichen)$/u;
    await page.getByTestId("app-edit").getByRole("button", { name: publish }).click();
    const dialog = page.getByRole("dialog");
    const notice = dialog.locator(`[data-data-store="${STORE}"]`).getByTestId("refusal-notice");
    await expect(notice).toContainText(sentences[locale]);
    const toStore = notice.getByRole("link", {
      name: locale === "de" ? "Datenspeicher öffnen" : "Open data store",
      exact: true
    });
    await expect(toStore).toHaveAttribute("href", `/build/data-stores/${STORE}`);
    await expect(dialog.getByRole("button", { name: publish })).toBeDisabled();
    const view = `${locale} ${width} ${theme}`;
    await expectInside(notice, dialog, `the notice (${view})`);
    await expectInside(toStore, dialog, `the way to the store (${view})`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

/** `inner` lies whole within `outer`, so nothing of it is cut off at the edge. */
async function expectInside(inner: Locator, outer: Locator, what: string): Promise<void> {
  const [box, frame] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  expect(box, what).not.toBeNull();
  expect(frame, what).not.toBeNull();
  if (!box || !frame) return;
  expect(box.x, `${what} starts inside the dialog`).toBeGreaterThanOrEqual(frame.x);
  expect(box.x + box.width, `${what} ends inside the dialog`).toBeLessThanOrEqual(
    frame.x + frame.width
  );
}
