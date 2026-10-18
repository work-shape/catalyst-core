import { randomUUID } from "node:crypto";
import type { Browser, Locator, Page, TestInfo } from "@playwright/test";
import { z } from "zod";
import { removeServicePrincipal } from "./connection-fixtures";
import { apiBaseUrl, signIn } from "./inbox-fixtures";
import { allowOnInstance } from "./publish-approval-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type PageErrorWatch } from "./test";

// PUBQ-1 in the browser, run from the serial Inbox spec because it makes a held publish: the three publish questions lead with the instance's one plain
// sentence on what the publish makes live, in the reader's language, with the lists behind
// "Details": the App's Publish dialog, the Workflow's publish question and the Inbox item of a
// held publish. The instance words the sentence in the language of the reader's account
// (#318), so the scenario sets it on an account of its own; the interface's language follows.
//
// Every run keeps a picture of each question in English and German, light and dark, 1280 and
// 390 pixels wide, as `pubq-1-*.png` in its output folder: the hosted run uploads them.

const admin = {
  email: "e2e-publish-narrative@example.test",
  password: "e2e-publish-narrative-password"
};
const member = {
  email: "e2e-publish-narrative-member@example.test",
  password: "e2e-publish-narrative-member-password",
  label: "E2E Zz Publish Narrative Member"
};

type Locale = "en" | "de";
type Theme = "light" | "dark";
type Surface = "app-dialog" | "workflow-question" | "inbox-item";
const LOCALES: readonly Locale[] = ["en", "de"];
const THEMES: readonly Theme[] = ["light", "dark"];
const WIDTHS = [1280, 390] as const;
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const idSchema = z.object({ id: z.string() });
const narrativeSchema = z.object({
  publishNarrative: z.object({ summary: z.string().min(1), warnings: z.array(z.string()) })
});

/** Sets the language of the admin's own account, which the instance words the sentence in. */
async function setAccountLocale(page: Page, locale: Locale | null): Promise<void> {
  const changed = await requestWithOrigin(page, "patch", `${apiBaseUrl}/api/v1/me`, {
    data: { locale }
  });
  expect(changed.ok(), await changed.text()).toBe(true);
}

/** The interface's theme and language, read when it loads. */
async function setLook(page: Page, locale: Locale, theme: Theme): Promise<void> {
  await page.evaluate(
    ([localeValue, themeValue]) => {
      window.localStorage.setItem("vivd-catalyst:locale", localeValue);
      window.localStorage.setItem("vivd-catalyst:theme", themeValue);
    },
    [locale, theme] as const
  );
}

/** The sentence the instance words for this reader, as the asset read of the revision has it. */
async function narrativeOf(page: Page, url: string): Promise<string> {
  const read = await page.request.get(url);
  expect(read.ok(), await read.text()).toBe(true);
  return narrativeSchema.parse(await read.json()).publishNarrative.summary;
}

const GERMAN_WORDS = /(?:\b(?:und|für|als|liest|läuft|öffnet|niemand|Leitplanke)\b|[äöüß])/u;

/**
 * Opens each publish question in each language, theme and width with the real instance's
 * sentence, and keeps the 24 pictures and one of each question's opened Details.
 */
export async function publishQuestionsLeadWithTheSentence(
  {
    page,
    browser,
    pageErrors,
    accessState: _accessState
  }: { page: Page; browser: Browser; pageErrors: PageErrorWatch; accessState: unknown },
  testInfo: TestInfo
): Promise<void> {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  const tag = randomUUID().slice(0, 8);
  const appId = `pubq-offers-${tag}`;
  const appName = `Offers ${tag}`;
  const workflowId = `pubq-nightly-${tag}`;
  const workflowName = `Nightly ${tag}`;
  const runAs = `${workflowId}-runner`;
  await page.setViewportSize(DESKTOP);
  await signIn(page, admin);
  await setAccountLocale(page, "en");

  // The member is known to the instance once they signed in; the rights to write and publish
  // Apps, and not to approve a publish, make their publish wait for an approver.
  const memberContext = await browser.newContext({ viewport: DESKTOP });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, member);
  const takeBack = await allowOnInstance(member.email, ["app.read", "app.write", "app.publish"]);
  let principalId: string | undefined;

  try {
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name: `Publish question ${tag}` }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = idSchema.parse(await created.json()).id;
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/members`,
      { data: { email: member.email } }
    );
    expect(added.ok(), await added.text()).toBe(true);

    // The App, a draft of two files in the workspace.
    const appUrl = `${apiBaseUrl}/api/v1/assets/app/${appId}`;
    const written = await requestWithOrigin(page, "put", appUrl, {
      data: {
        workspaceId,
        expectedRevision: null,
        files: [
          {
            path: "app.yaml",
            text: `id: ${appId}\nname: ${appName}\nkit: 1.1.0\nentry: index.html\n`
          },
          { path: "index.html", text: "<!doctype html><title>Offers</title><p>Offers</p>" }
        ]
      },
      timeout: 90_000
    });
    expect(written.ok(), await written.text()).toBe(true);

    // The Workflow, a draft that runs by hand as an account of its own.
    const principal = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/service-principals`,
      { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
    );
    expect(principal.ok(), await principal.text()).toBe(true);
    principalId = z.object({ principal: idSchema }).parse(await principal.json()).principal.id;
    const workflowUrl = `${apiBaseUrl}/api/v1/assets/workflow/${workflowId}`;
    const saved = await requestWithOrigin(page, "put", workflowUrl, {
      data: {
        expectedRevision: null,
        config: {
          name: workflowId,
          manifest: {
            id: workflowId,
            name: workflowName,
            description: "The publish question spec's Workflow.",
            runAs,
            inputs: { type: "object", additionalProperties: false },
            outputs: {
              type: "object",
              properties: { done: { type: "integer" } },
              required: ["done"]
            },
            steps: [
              {
                id: "start",
                name: "Start by hand",
                type: "trigger",
                triggers: [{ kind: "manual" }]
              },
              { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
            ]
          }
        }
      }
    });
    expect(saved.ok(), await saved.text()).toBe(true);

    // The member publishes the App: the revision waits for an approver in the Inbox.
    await memberPage.goto(`/w/${workspaceId}/app-drafts/${appId}`);
    const memberEdit = memberPage.getByTestId("app-edit");
    await memberEdit.getByRole("button", { name: /^(?:Publish|Veröffentlichen)$/u }).click();
    const memberDialog = memberPage.getByRole("dialog");
    await expect(memberDialog.getByTestId("publish-narrative-summary")).toBeVisible();
    await memberDialog.getByRole("button", { name: /^(?:Publish|Veröffentlichen)$/u }).click();
    await expect(memberPage.getByTestId("app-publish-waits")).toBeVisible();

    const dialog = page.getByRole("dialog");
    const appRevisionUrl = `${appUrl}?workspaceId=${workspaceId}&revision=1`;
    const workflowRevisionUrl = `${workflowUrl}?revision=1`;
    const confirmIn = (where: Locator) =>
      where.getByRole("button", { name: /^(?:Publish|Veröffentlichen)$/u });

    /** Opens one question on the page as it is loaded, and answers where its sentence stands. */
    const open: Record<Surface, () => Promise<Locator>> = {
      "app-dialog": async () => {
        await page.goto(`/w/${workspaceId}/app-drafts/${appId}`);
        await confirmIn(page.getByTestId("app-edit")).click();
        await expect(confirmIn(dialog)).toBeEnabled();
        return dialog;
      },
      "workflow-question": async () => {
        await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
        const bar = page.getByTestId("workflow-page").locator("[data-workflow-draft]");
        await confirmIn(bar).click();
        await expect(confirmIn(dialog)).toBeEnabled();
        return dialog;
      },
      "inbox-item": async () => {
        await page.goto("/inbox");
        const row = page.getByTestId("inbox-row").filter({ hasText: appName });
        await row.getByRole("button").first().click();
        const review = page.getByTestId("publish-review");
        await expect(review).toBeVisible();
        return review;
      }
    };

    /** What a question shows first, and that the lists it had before stand folded under it. */
    const expectLead = async (where: Locator, summary: string, locale: Locale) => {
      const lead = where.getByTestId("publish-narrative-summary");
      await expect(lead).toHaveText(summary);
      if (locale === "de") expect(summary).toMatch(GERMAN_WORDS);
      const details = where.getByTestId("publish-details");
      await expect(details.getByRole("button", { name: "Details", exact: true })).toHaveAttribute(
        "aria-expanded",
        "false"
      );
      // The sentence stands above Details, and nothing folded is shown.
      const leadBox = await lead.boundingBox();
      const detailsBox = await details.boundingBox();
      expect(leadBox && detailsBox && leadBox.y < detailsBox.y).toBe(true);
    };

    const sentences: Record<Locale, Record<Surface, string>> = {
      en: { "app-dialog": "", "workflow-question": "", "inbox-item": "" },
      de: { "app-dialog": "", "workflow-question": "", "inbox-item": "" }
    };
    let pictures = 0;
    for (const locale of LOCALES) {
      await setAccountLocale(page, locale);
      const app = await narrativeOf(page, appRevisionUrl);
      const workflow = await narrativeOf(page, workflowRevisionUrl);
      // The held publish shows the very sentence the Publish dialog leads with.
      sentences[locale] = { "app-dialog": app, "workflow-question": workflow, "inbox-item": app };
      for (const theme of THEMES) {
        for (const surface of ["app-dialog", "workflow-question", "inbox-item"] as const) {
          await page.setViewportSize(DESKTOP);
          await setLook(page, locale, theme);
          const where = await open[surface]();
          await expectLead(where, sentences[locale][surface], locale);
          for (const width of WIDTHS) {
            await page.setViewportSize(width === 390 ? PHONE : DESKTOP);
            await expect(where.getByTestId("publish-narrative-summary")).toBeInViewport();
            await page.screenshot({
              path: testInfo.outputPath(`pubq-1-${surface}-${locale}-${theme}-${width}.png`),
              animations: "disabled"
            });
            pictures += 1;
          }
        }
      }
    }
    expect(pictures).toBe(24);
    // Each sentence is the instance's own for the reader's language, not one text in both.
    for (const surface of ["app-dialog", "workflow-question"] as const) {
      expect(sentences.de[surface]).not.toBe(sentences.en[surface]);
    }

    // Details folds and opens again and again, and its lists are there while folded: Publish
    // never waited for them to be opened.
    await setAccountLocale(page, "en");
    await page.setViewportSize(DESKTOP);
    await setLook(page, "en", "light");
    for (const surface of ["app-dialog", "workflow-question", "inbox-item"] as const) {
      const where = await open[surface]();
      const trigger = where.getByRole("button", { name: "Details", exact: true });
      const folded = where.getByTestId("publish-details-content");
      await expect(folded).toBeAttached();
      await expect(folded).toBeHidden();
      for (let round = 0; round < 2; round += 1) {
        await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(folded).toBeVisible();
        if (round === 0) {
          await page.screenshot({
            path: testInfo.outputPath(`pubq-1-${surface}-details-en-light-1280.png`),
            animations: "disabled"
          });
        }
        await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(folded).toBeHidden();
      }
    }

    // While the sentence is read, Publish waits for it: the warnings come before the click.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) =>
        url.pathname === `/api/v1/assets/app/${appId}` && url.searchParams.get("revision") === "1",
      async (route) => {
        await held;
        await route.continue();
      }
    );
    await page.goto(`/w/${workspaceId}/app-drafts/${appId}`);
    await confirmIn(page.getByTestId("app-edit")).click();
    await expect(dialog.getByTestId("publish-narrative-loading")).toBeVisible();
    await expect(confirmIn(dialog)).toBeDisabled();
    release();
    await expect(dialog.getByTestId("publish-narrative-summary")).toHaveText(
      sentences.en["app-dialog"]
    );
    await expect(confirmIn(dialog)).toBeEnabled();
    await page.unrouteAll({ behavior: "wait" });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await setAccountLocale(page, null).catch(() => undefined);
    await takeBack();
    await memberContext.close();
    if (principalId) await removeServicePrincipal(principalId);
  }
}
