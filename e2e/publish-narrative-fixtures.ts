import { randomUUID } from "node:crypto";
import type { Browser, Locator, Page, TestInfo } from "@playwright/test";
import { z } from "zod";
import { removeConnection as removeAsset, removeServicePrincipal } from "./connection-fixtures";
import { apiBaseUrl, signIn } from "./inbox-fixtures";
import { allowOnInstance } from "./publish-approval-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type PageErrorWatch } from "./test";

// PUBQ-1 in the browser, run from the serial Inbox spec because it makes a held publish: the
// three publish questions lead with the instance's one plain sentence on what the publish makes
// live, in the reader's language, with the lists behind one "Details": the App's Publish
// dialog, the Workflow's publish question and the Inbox item of a held publish. The instance
// words the sentence in the language of the reader's account (#318), so the scenario sets it
// on an account of its own; the interface's language follows.
//
// The Workflow adds rows to a Data Store in a step a guardrail in force stops, so its question
// warns before the click. The App reads that store with one action and adds rows with another,
// so its question and the Inbox item name who sees which stored data (DS-13b) behind Details,
// where the Inbox item also keeps the call's technical details: one fold, not two.
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
 * sentence, and keeps the 48 pictures, closed and with Details open in every language, theme and width.
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
  const store = `pubq-kunden-${tag}`;
  const storeTitle = `Kunden ${tag}`;
  const guardrailName = `pubq_insert_${tag.replace(/-/gu, "_")}`;
  const guardrailTitle = `Kundenzeilen ${tag}`;
  const insertStep = "Add the clients";
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
  let guardrailId: string | undefined;

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

    // The store the Workflow fills and the App reads, with one table, published in the
    // workspace.
    const storeUrl = `${apiBaseUrl}/api/v1/assets/data_store/${store}`;
    const storeWritten = await requestWithOrigin(page, "put", storeUrl, {
      data: {
        workspaceId,
        expectedRevision: null,
        files: [
          { path: "store.yaml", text: `id: ${store}\nname: ${storeTitle}\n` },
          {
            path: "migrations/0001_init.sql",
            text: "create table kunden (id bigint generated by default as identity primary key, name text not null);"
          }
        ]
      },
      timeout: 90_000
    });
    expect(storeWritten.ok(), await storeWritten.text()).toBe(true);
    const storePublished = await requestWithOrigin(page, "post", `${storeUrl}/publish`, {
      data: { revision: 1, workspaceId },
      timeout: 90_000
    });
    expect(storePublished.ok(), await storePublished.text()).toBe(true);
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await (await page.request.get(`${apiBaseUrl}/api/v1/data-stores/${store}`)).json()
          ),
        { timeout: 60_000 }
      )
      .toContain('"ready"');

    // A guardrail in force on the Workflow's insert step: a published run cannot wait for the
    // approval it asks, so the Workflow's question warns of that step before the click.
    const guardrailUrl = `${apiBaseUrl}/api/v1/assets/guardrail/${guardrailName}`;
    const guarded = await requestWithOrigin(page, "put", guardrailUrl, {
      data: {
        expectedRevision: null,
        config: {
          name: guardrailName,
          displayName: guardrailTitle,
          on: "operation.before_call",
          filter: { operation: `data_store.${store}.insert` },
          check: { kind: "pattern", pattern: "Muster", reason: "New clients need an approval." },
          outcome: "require_approval"
        }
      }
    });
    expect(guarded.ok(), await guarded.text()).toBe(true);
    const guardPublished = await requestWithOrigin(page, "post", `${guardrailUrl}/publish`, {
      data: { revision: 1 }
    });
    expect(guardPublished.ok(), await guardPublished.text()).toBe(true);
    guardrailId = idSchema.parse(await (await page.request.get(guardrailUrl)).json()).id;

    // The App, a draft in the workspace whose actions read the store and add rows to it.
    const appUrl = `${apiBaseUrl}/api/v1/assets/app/${appId}`;
    const written = await requestWithOrigin(page, "put", appUrl, {
      data: {
        workspaceId,
        expectedRevision: null,
        files: [
          {
            path: "app.yaml",
            text: JSON.stringify({
              id: appId,
              name: appName,
              kit: "1.1.0",
              entry: "index.html",
              dataStores: [{ name: store, minSchema: 1 }],
              actions: [
                { name: "list_kunden", file: "actions/list_kunden.sql", effect: "reading" },
                { name: "add_kunde", file: "actions/add_kunde.sql", effect: "changing" }
              ]
            })
          },
          { path: "index.html", text: "<!doctype html><title>Offers</title><p>Offers</p>" },
          {
            path: "actions/list_kunden.sql",
            text: "-- The clients, by name.\n-- @param limit integer\nselect name from kunden order by name limit $limit\n"
          },
          {
            path: "actions/add_kunde.sql",
            text: "-- One new client.\n-- @param name text\ninsert into kunden (name) values ($name)\n"
          }
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
    const storeRead = await page.request.get(`${storeUrl}?workspaceId=${workspaceId}`);
    expect(storeRead.ok(), await storeRead.text()).toBe(true);
    const storeAsset = idSchema.parse(await storeRead.json());
    const insertGranted = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "service_principal",
          holderId: principalId,
          action: "data_store.insert",
          effect: "allow",
          scopeKind: "asset",
          scopeId: storeAsset.id
        }
      }
    );
    expect(insertGranted.ok(), await insertGranted.text()).toBe(true);
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
              {
                id: "store",
                name: insertStep,
                type: "operation",
                operation: `data_store.${store}.insert`,
                input: { table: { value: "kunden" }, rows: { value: [{ name: "Muster GmbH" }] } }
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

    let heldSummary: string | undefined;

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
        const answer = page.waitForResponse(
          (response) =>
            /^\/api\/v1\/approval-requests\/apr_[^/]+$/u.test(new URL(response.url()).pathname) &&
            response.request().method() === "GET" &&
            response.status() === 200
        );
        await row.getByRole("button").first().click();
        const held = z
          .object({ preview: z.object({ review: narrativeSchema }) })
          .parse(await (await answer).json());
        heldSummary = held.preview.review.publishNarrative.summary;
        // An approver sees the publisher's name; the publisher sees "Only me" (SHARE-1).
        expect(heldSummary).toContain(member.label);
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
      // One fold: the Inbox item's technical details stand inside Details, not beside it.
      await expect(where.getByTestId("operation-call-details")).toHaveCount(0);
    };

    /** What each question says beyond the sentence, in any language. */
    const expectContent = async (where: Locator, surface: Surface) => {
      const folded = where.getByTestId("publish-details-content");
      if (surface === "workflow-question") {
        // The step the guardrail stops, warned of before the click.
        const warnings = where.getByTestId("publish-narrative-warnings");
        await expect(warnings).toContainText(insertStep);
        await expect(warnings).toContainText(guardrailTitle);
        await expect(where.getByTestId("publish-narrative-summary")).toContainText(storeTitle);
        return;
      }
      // The App's actions read the store and add rows to it; who sees which stored data
      // (DS-13b) stands behind Details, kept in the page while folded.
      await expect(where.getByTestId("publish-narrative-summary")).toContainText(storeTitle);
      await expect(folded.locator('[data-field="data-stored"]')).toBeAttached();
      await expect(folded.locator(`[data-data-store="${store}"]`)).toContainText("list_kunden");
      await expect(folded.locator("[data-data-store-rows]").first()).toBeAttached();
      if (surface === "inbox-item") {
        await expect(folded.getByTestId("publish-details-technical")).toBeAttached();
        await expect(folded.locator('[data-field="operation"]')).toContainText("publish");
      }
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
      // Each surface shows its reader's sentence; the held private publish names its publisher.
      sentences[locale] = { "app-dialog": app, "workflow-question": workflow, "inbox-item": app };
      for (const theme of THEMES) {
        for (const surface of ["app-dialog", "workflow-question", "inbox-item"] as const) {
          await page.setViewportSize(DESKTOP);
          await setLook(page, locale, theme);
          const where = await open[surface]();
          if (surface === "inbox-item") {
            expect(heldSummary).toBeDefined();
            sentences[locale][surface] = heldSummary ?? "";
          }
          await expectLead(where, sentences[locale][surface], locale);
          await expectContent(where, surface);
          for (const width of WIDTHS) {
            await page.setViewportSize(width === 390 ? PHONE : DESKTOP);
            await expect(where.getByTestId("publish-narrative-summary")).toBeInViewport();
            await page.screenshot({
              path: testInfo.outputPath(`pubq-1-${surface}-${locale}-${theme}-${width}.png`),
              animations: "disabled"
            });
            pictures += 1;
            const trigger = where.getByRole("button", { name: "Details", exact: true });
            await trigger.click();
            await expect(trigger).toHaveAttribute("aria-expanded", "true");
            const details = where.getByTestId("publish-details-content");
            await expect(details).toBeVisible();
            if (surface !== "workflow-question") {
              const rows = details.locator("[data-data-store-rows]").first();
              await expect(rows).toBeVisible();
              await rows.scrollIntoViewIfNeeded();
            }
            await page.screenshot({
              path: testInfo.outputPath(
                `pubq-1-${surface}-details-${locale}-${theme}-${width}.png`
              ),
              animations: "disabled"
            });
            pictures += 1;
            await trigger.click();
            await expect(trigger).toHaveAttribute("aria-expanded", "false");
          }
        }
      }
    }
    expect(pictures).toBe(48);
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
    // The guardrail binds nothing but this spec's store; it goes with the spec all the same.
    if (guardrailId) await removeAsset(guardrailId);
  }
}
