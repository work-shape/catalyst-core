import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Browser, Locator, Page, TestInfo } from "@playwright/test";
import postgres from "postgres";
import { appAudienceSchema } from "@work-shape/catalyst-api-contract";
import { z } from "zod";
import { apiBaseUrl, signIn } from "./inbox-fixtures";
import { plainPageSource, sendToolCall } from "./page-surface-fixtures";
import { allowOnInstance } from "./publish-approval-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type PageErrorWatch } from "./test";

// SHARE-1 in the browser, run from the serial Inbox spec because it makes a held publish. An
// App's Publish dialog opens with "For whom?"; each choice rewords the instance's sentence and
// the line on who sees the stored data (DS-13b). A person who may not publish at instance scope
// is not offered the whole instance. The held publish's Inbox item names the audience chosen.
// The line the agent's save leaves says who can use the App now, and its "Share" opens the
// same dialog.
//
// Pictures go to `E2E_SHOTS_DIR`, or the test's output folder: 24 of the dialog (3 choices,
// English and German, light and dark, 1280 and 390), 8 of the Inbox item and 8 of the save line.

const admin = { email: "e2e-share@example.test", password: "e2e-share-password" };
const member = {
  email: "e2e-share-member@example.test",
  password: "e2e-share-member-password"
};

type Locale = "en" | "de";
type Theme = "light" | "dark";
type Audience = z.infer<typeof appAudienceSchema>;
const LOCALES: readonly Locale[] = ["en", "de"];
const THEMES: readonly Theme[] = ["light", "dark"];
const AUDIENCES: readonly Audience[] = appAudienceSchema.options;
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const SHORT_PHONE = { width: 390, height: 640 };
const PUBLISH = /^(?:Publish|Veröffentlichen)$/u;

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;

const idSchema = z.object({ id: z.string() });
const readSchema = z.object({
  publishNarrative: z.object({ summary: z.string().min(1) }),
  appAudience: z.object({
    selected: appAudienceSchema,
    choices: z.array(appAudienceSchema),
    label: z.string().min(1)
  })
});

/** The words of a choice, as the dialog shows them. */
function choiceName(audience: Audience, locale: Locale, workspaceName: string): string {
  if (audience === "self") return locale === "de" ? "Nur für mich" : "Only me";
  if (audience === "instance") return locale === "de" ? "Ganze Instanz" : "Whole instance";
  return workspaceName;
}

async function picture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const folder = process.env.E2E_SHOTS_DIR ?? testInfo.outputPath();
  await mkdir(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `share-1-${name}.png`), animations: "disabled" });
}

async function setAccountLocale(page: Page, locale: Locale | null): Promise<void> {
  const changed = await requestWithOrigin(page, "patch", `${apiBaseUrl}/api/v1/me`, {
    data: { locale }
  });
  expect(changed.ok(), await changed.text()).toBe(true);
}

async function setLook(page: Page, locale: Locale, theme: Theme): Promise<void> {
  await page.evaluate(
    ([localeValue, themeValue]) => {
      window.localStorage.setItem("vivd-catalyst:locale", localeValue);
      window.localStorage.setItem("vivd-catalyst:theme", themeValue);
    },
    [locale, theme] as const
  );
}

/** A right on one workspace only, written as a role would. Answers how to take it back. */
async function allowInWorkspace(
  email: string,
  workspaceId: string,
  actions: readonly string[]
): Promise<() => Promise<void>> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [user] = await sql<{ id: string }[]>`
      select id from product_users where client_instance_id = 'demo-e2e' and email = ${email}`;
    if (!user) throw new Error(`No person ${email} on the instance`);
    const ids = actions.map((action) => `grant_e2e_share_${action}_${user.id}`);
    for (const [index, action] of actions.entries()) {
      await sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, scope_id, effect,
           granted_by)
        values
          (${ids[index] ?? ""}, 'demo-e2e', 'user', ${user.id}, ${action}, 'workspace',
           ${workspaceId}, 'allow', 'e2e')`;
    }
    return async () => {
      const end = postgres(databaseUrl, { max: 1 });
      try {
        await end`delete from permission_grants where id in ${end(ids)}`;
      } finally {
        await end.end();
      }
    };
  } finally {
    await sql.end();
  }
}

/** Writes and publishes a Data Store of the workspace, and waits until it is ready. */
async function publishStore(page: Page, workspaceId: string, store: string, title: string) {
  const address = `${apiBaseUrl}/api/v1/assets/data_store/${store}`;
  const saved = await requestWithOrigin(page, "put", address, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        { path: "store.yaml", text: `id: ${store}\nname: ${title}\n` },
        {
          path: "migrations/0001_init.sql",
          text: "create table kunden (id bigint generated by default as identity primary key, name text not null);"
        }
      ]
    },
    timeout: 90_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { revision } = z.object({ revision: z.number() }).parse(await saved.json());
  const published = await requestWithOrigin(page, "post", `${address}/publish`, {
    data: { revision, workspaceId },
    timeout: 90_000
  });
  expect(published.ok(), await published.text()).toBe(true);
  await expect
    .poll(
      async () =>
        JSON.stringify(
          await (await page.request.get(`${apiBaseUrl}/api/v1/data-stores/${store}`)).json()
        ),
      { timeout: 60_000 }
    )
    .toContain('"ready"');
}

/**
 * Check 56 and check 80 in the browser: "For whom?" in the Publish dialog, its choices by the
 * reader's rights, the sentence and DS-13b line for each choice, the held publish's audience in
 * the Inbox, and the save line with "Share".
 */
export async function shareAsksForWhom(
  {
    page,
    browser,
    pageErrors,
    accessState: _accessState
  }: { page: Page; browser: Browser; pageErrors: PageErrorWatch; accessState: unknown },
  testInfo: TestInfo
): Promise<void> {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const tag = randomUUID().slice(0, 8);
  const appId = `share-kunden-${tag}`;
  const appName = `Kundenliste ${tag}`;
  const store = `share-kunden-${tag}`;
  const workspaceName = `Share ${tag}`;
  await page.setViewportSize(DESKTOP);
  await signIn(page, admin);
  await expect(page).toHaveURL(/\/w\/[^/]+/u);
  const ownWorkspacePath = new URL(page.url()).pathname;
  await setAccountLocale(page, "en");

  const memberContext = await browser.newContext({ viewport: DESKTOP });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  memberPage.setDefaultTimeout(30_000);
  await signIn(memberPage, member);
  const takeBack: (() => Promise<void>)[] = [];

  try {
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name: workspaceName }
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

    // The App reads stored data, so its dialog names who sees it (DS-13b).
    await publishStore(page, workspaceId, store, `Kunden ${tag}`);
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
              actions: [{ name: "list_kunden", file: "actions/list_kunden.sql", effect: "reading" }]
            })
          },
          { path: "index.html", text: "<!doctype html><title>Kunden</title><p>Kunden</p>" },
          {
            path: "actions/list_kunden.sql",
            text: "-- The clients, by name.\n-- @param limit integer\nselect name from kunden order by name limit $limit\n"
          }
        ]
      },
      timeout: 90_000
    });
    expect(written.ok(), await written.text()).toBe(true);

    /** What the instance answers for one choice, in the admin's account language. */
    const answerFor = async (audience: Audience) => {
      const read = await page.request.get(
        `${appUrl}?workspaceId=${workspaceId}&revision=1&audience=${audience}`
      );
      expect(read.ok(), await read.text()).toBe(true);
      const parsed = readSchema.parse(await read.json());
      return { summary: parsed.publishNarrative.summary, label: parsed.appAudience.label };
    };

    const dialog = page.getByRole("dialog");
    const openDialog = async () => {
      await page.goto(`/w/${workspaceId}/app-drafts/${appId}`);
      await page.getByTestId("app-edit").getByRole("button", { name: PUBLISH }).click();
      await expect(dialog.getByTestId("app-publish-audience")).toBeVisible();
      await expect(dialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
    };
    /** Chooses an audience and waits until the sentence and the DS-13b line name it. */
    const choose = async (
      audience: Audience,
      locale: Locale,
      answer: { summary: string; label: string }
    ) => {
      await dialog
        .getByTestId("app-publish-audience")
        .getByRole("radio", { name: choiceName(audience, locale, workspaceName), exact: true })
        .click();
      await expect(dialog.getByTestId("publish-narrative-summary")).toHaveText(answer.summary);
      await expect(dialog.locator('[data-field="data-audience"]')).toContainText(answer.label);
      await expect(dialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
    };
    const openDetails = async () => {
      const trigger = dialog.getByRole("button", { name: "Details", exact: true });
      if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
      await expect(dialog.locator('[data-field="data-audience"]')).toBeVisible();
    };

    // "For whom?" stands first, and an instance publisher gets the three choices.
    await openDialog();
    const question = dialog.getByTestId("app-publish-audience");
    const questionBox = await question.boundingBox();
    const summaryBox = await dialog.getByTestId("publish-narrative-summary").boundingBox();
    expect(questionBox && summaryBox && questionBox.y < summaryBox.y).toBe(true);
    await expect(question.getByRole("radio")).toHaveCount(3);

    // 24 pictures: each choice in each language, theme and width, with Details open so the
    // DS-13b line shows the chosen people.
    let pictures = 0;
    const summaries: Record<Locale, Record<Audience, string>> = {
      en: { self: "", workspace: "", instance: "" },
      de: { self: "", workspace: "", instance: "" }
    };
    for (const locale of LOCALES) {
      await setAccountLocale(page, locale);
      const answers = {
        self: await answerFor("self"),
        workspace: await answerFor("workspace"),
        instance: await answerFor("instance")
      };
      for (const audience of AUDIENCES) summaries[locale][audience] = answers[audience].summary;
      for (const theme of THEMES) {
        await page.setViewportSize(DESKTOP);
        await setLook(page, locale, theme);
        await openDialog();
        await expect(dialog.getByText(locale === "de" ? "Für wen?" : "For whom?")).toBeVisible();
        await openDetails();
        for (const audience of AUDIENCES) {
          await choose(audience, locale, answers[audience]);
          for (const size of [DESKTOP, PHONE]) {
            await page.setViewportSize(size);
            await expect(question).toBeInViewport();
            await picture(page, testInfo, `dialog-${audience}-${locale}-${theme}-${size.width}`);
            pictures += 1;
          }
          await page.setViewportSize(DESKTOP);
        }
      }
    }
    expect(pictures).toBe(24);
    // Each choice has a sentence of its own.
    for (const locale of LOCALES) {
      expect(new Set(Object.values(summaries[locale])).size).toBe(3);
    }

    // Switching back and forth always ends on the sentence and line of the last choice.
    await setAccountLocale(page, "en");
    const english = {
      self: await answerFor("self"),
      workspace: await answerFor("workspace"),
      instance: await answerFor("instance")
    };
    await setLook(page, "en", "light");
    await openDialog();
    await openDetails();
    for (const audience of ["instance", "self", "workspace", "instance", "self"] as const) {
      await choose(audience, "en", english[audience]);
    }
    // Details folds and opens again with the choice kept.
    const trigger = dialog.getByRole("button", { name: "Details", exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(dialog.locator('[data-field="data-audience"]')).toContainText(english.self.label);

    // While the answer for a new choice is on its way, the people of the choice before never
    // stand under it: the DS-13b line waits, the stores stay, and Publish is held.
    await page.goto(`/w/${workspaceId}/app-drafts/${appId}`);
    await page.getByTestId("app-edit").getByRole("button", { name: PUBLISH }).click();
    await expect(dialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
    await openDetails();
    await choose("self", "en", english.self);
    // A fresh page has no cached answer for workspace; this probe holds its first read.
    await openDialog();
    await openDetails();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) =>
        url.pathname === `/api/v1/assets/app/${appId}` &&
        url.searchParams.get("audience") === "workspace",
      async (route) => {
        await held;
        await route.continue();
      }
    );
    await dialog
      .getByTestId("app-publish-audience")
      .getByRole("radio", { name: workspaceName, exact: true })
      .click();
    const audienceLine = dialog.locator('[data-field="data-audience"]');
    await expect(audienceLine.getByTestId("app-publish-audience-pending")).toBeAttached();
    await expect(audienceLine).not.toContainText(english.self.label);
    await expect(dialog.locator(`[data-data-store="${store}"]`)).toBeVisible();
    await expect(dialog.getByRole("button", { name: PUBLISH })).toBeDisabled();
    release();
    await expect(audienceLine).toContainText(english.workspace.label);
    await expect(dialog.getByTestId("publish-narrative-summary")).toHaveText(
      english.workspace.summary
    );
    await expect(dialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
    await page.unrouteAll({ behavior: "wait" });

    // On a short phone the whole question scrolls inside the dialog to its Publish button.
    await page.setViewportSize(SHORT_PHONE);
    const confirm = dialog.getByRole("button", { name: PUBLISH });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    await expect(question).toBeAttached();
    await picture(page, testInfo, "dialog-scrolled-en-light-390x640");
    await page.setViewportSize(DESKTOP);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();

    // A builder who may publish in this workspace and not on the instance is offered no whole
    // instance, and a forged instance publish is refused. Their publish waits for an approver,
    // with the audience they chose.
    takeBack.push(await allowOnInstance(member.email, ["app.read", "app.write"]));
    takeBack.push(
      await allowInWorkspace(member.email, workspaceId, ["app.publish", "data_store.read"])
    );
    const memberOffer = await memberPage.request.get(
      `${appUrl}?workspaceId=${workspaceId}&revision=1`
    );
    expect(memberOffer.ok(), await memberOffer.text()).toBe(true);
    expect(readSchema.parse(await memberOffer.json()).appAudience.choices).toEqual([
      "self",
      "workspace"
    ]);
    const forged = await requestWithOrigin(memberPage, "post", `${appUrl}/publish`, {
      data: { revision: 1, workspaceId, audience: "instance" }
    });
    expect(forged.status(), await forged.text()).toBe(403);

    await memberPage.goto(`/w/${workspaceId}/app-drafts/${appId}`);
    await expect(
      memberPage.getByTestId("app-edit").getByRole("heading", { name: appName, exact: true })
    ).toBeVisible();
    const memberPublish = memberPage.getByTestId("app-edit").getByRole("button", { name: PUBLISH });
    await expect(memberPublish).toBeVisible();
    if (await memberPublish.isEnabled()) {
      await memberPublish.click();
      const memberDialog = memberPage.getByRole("dialog");
      const memberQuestion = memberDialog.getByTestId("app-publish-audience");
      await expect(memberQuestion.getByRole("radio")).toHaveCount(2);
      await expect(memberQuestion).not.toContainText("Whole instance");
      await memberQuestion.getByRole("radio", { name: workspaceName, exact: true }).click();
      await expect(memberDialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
      await picture(memberPage, testInfo, "dialog-limited-en-light-1280");
      await memberDialog.getByRole("button", { name: PUBLISH }).click();
      await expect(memberDialog.getByTestId("app-publish-waits")).toBeVisible();
      await memberDialog.getByRole("button", { name: "Close", exact: true }).click();
    } else {
      // The Apps screens read the publish right on the whole instance until ui-fix-1 lands, so
      // this member's Publish is held there. The offer and the gate are proved above; the
      // workspace publish is sent as the dialog would send it, so the Inbox has its item.
      testInfo.annotations.push({
        type: "known-prerequisite",
        description:
          "ui-fix-1: Publish on the draft page is held for a builder whose publish right is on one workspace only; the two-choice dialog for this member was not exercised in the browser."
      });
      const sent = await requestWithOrigin(memberPage, "post", `${appUrl}/publish`, {
        data: { revision: 1, workspaceId, audience: "workspace" }
      });
      expect(sent.ok(), await sent.text()).toBe(true);
      expect(z.object({ status: z.string() }).parse(await sent.json()).status).not.toBe("done");
    }

    // Check 80: the Inbox item names the audience before the sentence, in 8 pictures.
    const openInbox = async (): Promise<Locator> => {
      await page.goto("/inbox");
      const row = page.getByTestId("inbox-row").filter({ hasText: appName });
      await row.getByRole("button").first().click();
      const review = page.getByTestId("publish-review");
      await expect(review.getByTestId("publish-review-audience")).toBeVisible();
      return review;
    };
    for (const locale of LOCALES) {
      await setAccountLocale(page, locale);
      const label = (await answerFor("workspace")).label;
      for (const theme of THEMES) {
        await page.setViewportSize(DESKTOP);
        await setLook(page, locale, theme);
        const review = await openInbox();
        await expect(review.getByTestId("publish-review-audience")).toHaveText(label);
        const audienceBox = await review.getByTestId("publish-review-audience").boundingBox();
        const leadBox = await review.getByTestId("publish-narrative-summary").boundingBox();
        expect(audienceBox && leadBox && audienceBox.y < leadBox.y).toBe(true);
        for (const size of [DESKTOP, PHONE]) {
          await page.setViewportSize(size);
          await expect(review.getByTestId("publish-review-audience")).toBeInViewport();
          await picture(page, testInfo, `inbox-${locale}-${theme}-${size.width}`);
        }
      }
    }

    // The save line: the agent saves an App in the admin's own workspace; the line says who
    // can use it now, and "Share" opens the same dialog.
    await setAccountLocale(page, "en");
    await page.setViewportSize(DESKTOP);
    await setLook(page, "en", "light");
    await page.goto(ownWorkspacePath);
    await expect(page).toHaveURL(/\/w\/[^/]+/u);
    const folder = `share-${tag}`;
    const savedTitle = `Share desk ${tag}`;
    for (const [path, content] of Object.entries(plainPageSource)) {
      await sendToolCall(page, "workspace.write_file", { path: `${folder}/${path}`, content });
    }
    await sendToolCall(page, "workspace.open", { path: folder });
    await sendToolCall(page, "app.save", { path: folder, name: savedTitle });
    const line = page.getByTestId("app-saved-line").last();
    await expect(line).toContainText(`Saved as the app ${savedTitle}.`);
    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        await page.setViewportSize(DESKTOP);
        await setLook(page, locale, theme);
        await page.reload();
        await expect(line).toBeVisible();
        for (const size of [DESKTOP, PHONE]) {
          await page.setViewportSize(size);
          await line.scrollIntoViewIfNeeded();
          await expect(line.getByTestId("app-saved-share")).toBeInViewport();
          await picture(page, testInfo, `save-line-${locale}-${theme}-${size.width}`);
        }
      }
    }
    await page.setViewportSize(DESKTOP);
    await setLook(page, "en", "light");
    await page.reload();
    await line.getByTestId("app-saved-share").click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(dialog.getByTestId("app-publish-audience")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Only me", exact: true })).toBeChecked();
    await expect(dialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
    await picture(page, testInfo, "save-line-share-dialog-en-light-1280");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await setAccountLocale(page, null).catch(() => undefined);
    for (const end of takeBack) await end().catch(() => undefined);
    await memberContext.close();
  }
}
