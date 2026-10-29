import type { Page, Route, TestInfo } from "@playwright/test";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { pageSource, pageSurface, savePage, writePageFiles } from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// DS-13c, Data Stores check 68 (browser half): the widening check is the instance's, asked in
// the publish; the App's publish dialog only shows its answer. Where it holds, one line says
// so. Where the publish hands a source's data to readers who may not use the source, the dialog
// says how many, never who: a holder of the source confirms by publishing, and the publish
// carries the confirmation; anyone else cannot send it, and the instance's refusal reads as the
// interface's German sentence. The instance's answers are stood in for here; the server half
// is tests/data-store-handover-publish.test.ts.

const REFUSED_TITLE = "a publish nobody may confirm is refused in German, naming no one";

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "data-handover-refused",
        reason:
          "Chromium's own log line: the test answers the App's publish with the refusal the " +
          "instance gives a hand-over its publisher may not confirm, and asserts the sentence.",
        matches: requestAnswered(403),
        path: /^\/api\/v1\/assets\/app\/[^/]+\/publish$/u,
        tests: [REFUSED_TITLE]
      }
    ]
  }
});

/** The person of this spec, from `tests/fixtures/e2e-users/data-handover.yaml`. */
const person = {
  email: "e2e-data-handover@example.test",
  password: "e2e-data-handover-password"
};

const CONFIRMATION = "a".repeat(64);
const idSchema = z.object({ id: z.string() });
const publishBodySchema = z.object({ confirmHandover: z.string().optional() }).loose();

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

/** Signs in, builds a Page in a new workspace and saves it as an App named `appName`. */
async function appDraft(page: Page, appName: string): Promise<void> {
  await signIn(page);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: "Team" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  await page.goto(`/w/${workspaceId}`);
  await writePageFiles(page, pageSource("Overview"));
  await savePage(page);
  const surface = pageSurface(page);
  await expect(surface).toBeVisible();
  await surface.getByRole("button", { name: /^(?:Save as app|Als App speichern)$/u }).click();
  const saveDialog = page.getByRole("dialog");
  await saveDialog.getByRole("textbox", { name: /^Name/u }).fill(appName);
  await saveDialog.getByRole("button", { name: /^(?:Save|Speichern)$/u }).click();
  await expect(page).toHaveURL(/\/app-drafts\/[^/]+$/u);
}

/** Answers the App's read with the instance's answer of the check in place of its own. */
async function answerHandover(page: Page, handover: Record<string, unknown>): Promise<void> {
  await page.route(
    (url) => /^\/api\/v1\/assets\/app\/[^/]+$/u.test(url.pathname),
    async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const asset = z.record(z.string(), z.unknown()).parse(await response.json());
      await route.fulfill({ response, json: { ...asset, publishHandover: handover } });
    }
  );
}

/** Opens the German publish dialog of the App. */
async function openDialog(page: Page, appName: string) {
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.reload();
  await page
    .getByTestId("app-edit")
    .getByRole("button", { name: "Veröffentlichen", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: `„${appName}“ veröffentlichen?` });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("where everyone who reads the store may use its source, one line says so", async ({
  page
}, testInfo) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(30000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const appName = appNameOf("Übersicht hält", testInfo);
  await appDraft(page, appName);
  await answerHandover(page, {
    holds: true,
    lines: ["Alle, die „Findings“ lesen, dürfen „Exampledata“ nutzen."]
  });
  const dialog = await openDialog(page, appName);
  const handover = dialog.getByTestId("app-publish-handover");
  await expect(handover).toHaveText("Alle, die „Findings“ lesen, dürfen „Exampledata“ nutzen.");
  await expect(dialog.getByRole("button", { name: "Veröffentlichen", exact: true })).toBeEnabled();
});

test("a holder of the source confirms the hand-over by publishing", async ({ page }, testInfo) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(30000);
  await page.setViewportSize({ width: 390, height: 900 });
  const appName = appNameOf("Übersicht bestätigt", testInfo);
  await appDraft(page, appName);
  await answerHandover(page, {
    holds: false,
    lines: [
      "3 Personen, die „Findings“ danach lesen, dürfen „Exampledata“ nicht nutzen. Mit Veröffentlichen bestätigst du die Weitergabe."
    ],
    confirmation: CONFIRMATION
  });
  const sent: unknown[] = [];
  // The publish reaches the instance with the confirmation; this App hands no store on, so
  // the instance publishes it.
  await page.route("**/api/v1/assets/app/*/publish", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.continue();
  });
  const dialog = await openDialog(page, appName);
  const handover = dialog.getByTestId("app-publish-handover");
  await expect(handover).toContainText("Weitergabe von Quelldaten");
  await expect(handover).toContainText(
    "3 Personen, die „Findings“ danach lesen, dürfen „Exampledata“ nicht nutzen."
  );
  await expect(handover).toContainText("Mit Veröffentlichen bestätigst du die Weitergabe.");
  await expect(handover).toBeInViewport();
  await dialog.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(publishBodySchema.parse(sent[0]).confirmHandover).toBe(CONFIRMATION);
  await expect(dialog).toBeHidden();
});

test(REFUSED_TITLE, async ({ page }, testInfo) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(30000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const appName = appNameOf("Übersicht abgelehnt", testInfo);
  await appDraft(page, appName);
  // The question tells who confirms and offers no confirmation: Publish cannot be sent.
  await answerHandover(page, {
    holds: false,
    lines: [
      "3 Personen, die „Findings“ danach lesen, dürfen eine für dich verborgene Quelle nicht nutzen. Die Weitergabe bestätigt eine Person, die die Quelle verwalten darf, indem sie veröffentlicht."
    ]
  });
  const dialog = await openDialog(page, appName);
  await expect(dialog.getByTestId("app-publish-handover")).toContainText(
    "Die Weitergabe bestätigt eine Person, die die Quelle verwalten darf"
  );
  const send = dialog.getByRole("button", { name: "Veröffentlichen", exact: true });
  await expect(send).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Sent anyway, as an agent or the CLI could, the instance refuses it; the interface words
  // the refusal in German and names how many, never who, and no source the reader cannot see.
  await page.unrouteAll({ behavior: "wait" });
  await page.route("**/api/v1/assets/app/*/publish", (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: "FORBIDDEN",
          message:
            "3 people who would read the Data Store 'Findings' after this publish may not use one of its sources. Only a person who holds connection.write on that Connection may confirm the hand-over.",
          details: {
            reason: "data_handover_needs_owner",
            dataStore: "findings",
            title: "Findings",
            readers: 3
          }
        }
      }
    })
  );
  const again = await openDialog(page, appName);
  await again.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
  const refusal = again.getByTestId("refusal-notice");
  await expect(refusal).toContainText(
    "3 Personen, die den Datenspeicher „Findings“ danach lesen, dürfen eine seiner Quellen nicht nutzen. Bitte eine Person, die diese Quelle verwalten darf, diese Version zu veröffentlichen und die Weitergabe zu bestätigen, oder schränke ein, wer den Datenspeicher liest."
  );
  await expect(refusal).not.toContainText(/connection\.write|people/u);
  await expect(
    refusal.getByRole("link", { name: "Datenspeicher öffnen", exact: true })
  ).toHaveAttribute("href", "/build/data-stores/findings");
});
