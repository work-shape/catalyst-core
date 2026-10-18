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
// Fix round: a live App may be published again for another audience only; a workspace
// publisher of an instance-wide App is offered what they may choose, the widest chosen, and
// told who it is shared with now; the stored-data line keeps the App's grant holders and the
// instance admins; an agent's publish asks the person "For whom?" before Allow and publishes
// their choice, never anything before the click.
//
// Pictures go to `E2E_SHOTS_DIR`, or the test's output folder. Each set is English and German,
// light and dark, 1280 and 390: the dialog for each choice (24), the Inbox item (8), the
// audience-only change (8), the narrowing dialog (8, where the member may publish here), the
// agent's confirmation (8) and the save line (8).

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
const ALLOW = /^(?:Allow|Erlauben)$/u;
const SIZES = [DESKTOP, PHONE] as const;

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;

const idSchema = z.object({ id: z.string() });
const readSchema = z.object({
  publishedRevision: z.number().optional(),
  publishNarrative: z.object({ summary: z.string().min(1) }),
  appAudience: z.object({
    selected: appAudienceSchema,
    live: appAudienceSchema.optional(),
    liveLabel: z.string().optional(),
    people: z.number().optional(),
    choices: z.array(appAudienceSchema),
    label: z.string().min(1)
  })
});

/** What the instance says of revision 1 of an App for this person: what is live, for whom. */
async function readApp(page: Page, appUrl: string, workspaceId: string, audience?: Audience) {
  const read = await page.request.get(
    `${appUrl}?workspaceId=${workspaceId}&revision=1${audience ? `&audience=${audience}` : ""}`
  );
  expect(read.ok(), await read.text()).toBe(true);
  return readSchema.parse(await read.json());
}

/** Each language, theme and width in turn, with a fresh page in that language and theme. */
async function eachLook(
  page: Page,
  show: (locale: Locale) => Promise<Locator>,
  shoot: (locale: Locale, theme: Theme, width: number) => Promise<void>
): Promise<number> {
  let count = 0;
  for (const locale of LOCALES) {
    await setAccountLocale(page, locale);
    for (const theme of THEMES) {
      await page.setViewportSize(DESKTOP);
      await setLook(page, locale, theme);
      const shown = await show(locale);
      for (const size of SIZES) {
        await page.setViewportSize(size);
        await shown.scrollIntoViewIfNeeded();
        await expect(shown).toBeInViewport();
        await shoot(locale, theme, size.width);
        count += 1;
      }
    }
  }
  await page.setViewportSize(DESKTOP);
  await setAccountLocale(page, "en");
  await setLook(page, "en", "light");
  return count;
}

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
      const line = dialog.locator('[data-field="data-audience"]');
      await expect(line).toContainText(answer.label);
      // A chosen audience never hides that the instance admins see the data too.
      await expect(line.getByTestId("app-publish-data-admins")).toBeVisible();
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

    // The admin makes revision 1 live for the whole instance.
    await setAccountLocale(page, "en");
    await setLook(page, "en", "light");
    await page.setViewportSize(DESKTOP);
    await openDialog();
    await question.getByRole("radio", { name: "Whole instance", exact: true }).click();
    await expect(dialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
    await dialog.getByRole("button", { name: PUBLISH }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await readApp(page, appUrl, workspaceId)).appAudience.live)
      .toBe("instance");
    const liveRevision = (await readApp(page, appUrl, workspaceId)).publishedRevision;
    expect(liveRevision).toBe(1);

    // Audience only: the draft is what is live, and Publish still opens the question. It holds
    // Publish while the live audience is chosen and lets it go once another one is.
    const openLiveDialog = async (): Promise<Locator> => {
      await page.goto(`/w/${workspaceId}/app-drafts/${appId}`);
      const pagePublish = page.getByTestId("app-edit").getByRole("button", { name: PUBLISH });
      await expect(pagePublish).toBeEnabled();
      await pagePublish.click();
      await expect(question.getByRole("radio", { checked: true })).toHaveCount(1);
      await expect(dialog.getByRole("button", { name: PUBLISH })).toBeDisabled();
      return question;
    };
    await openLiveDialog();
    await expect(
      question.getByRole("radio", { name: "Whole instance", exact: true })
    ).toBeChecked();
    await expect(dialog.getByTestId("app-publish-audience-change")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    const audienceOnly = await eachLook(
      page,
      async (locale) => {
        await openLiveDialog();
        await question
          .getByRole("radio", { name: choiceName("workspace", locale, workspaceName), exact: true })
          .click();
        const change = dialog.getByTestId("app-publish-audience-change");
        await expect(change).toHaveText(
          locale === "de"
            ? `Jetzt geteilt: Alle in der Instanz. Nach dem Veröffentlichen: Alle in ${workspaceName}.`
            : `Shared now: Everyone in the instance. After publishing: Everyone in ${workspaceName}.`
        );
        await expect(dialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
        return change;
      },
      (locale, theme, width) => picture(page, testInfo, `audience-only-${locale}-${theme}-${width}`)
    );
    expect(audienceOnly).toBe(8);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();

    // Narrowing: the member may publish in this workspace only. On the instance-wide App the
    // instance offers them what they may choose, the widest chosen, and says who has it now.
    const memberRead = await readApp(memberPage, appUrl, workspaceId);
    expect(memberRead.appAudience.live).toBe("instance");
    expect(memberRead.appAudience.choices).toEqual(["self", "workspace"]);
    expect(memberRead.appAudience.selected).toBe("workspace");
    await memberPage.goto(`/w/${workspaceId}/app-drafts/${appId}`);
    const memberLivePublish = memberPage
      .getByTestId("app-edit")
      .getByRole("button", { name: PUBLISH });
    await expect(memberLivePublish).toBeVisible();
    if (await memberLivePublish.isEnabled()) {
      const memberDialog = memberPage.getByRole("dialog");
      const narrowing = await eachLook(
        memberPage,
        async (locale) => {
          await memberPage.goto(`/w/${workspaceId}/app-drafts/${appId}`);
          await memberPage.getByTestId("app-edit").getByRole("button", { name: PUBLISH }).click();
          const memberQuestion = memberDialog.getByTestId("app-publish-audience");
          await expect(memberQuestion.getByRole("radio")).toHaveCount(2);
          await expect(
            memberQuestion.getByRole("radio", { name: workspaceName, exact: true })
          ).toBeChecked();
          const change = memberDialog.getByTestId("app-publish-audience-change");
          await expect(change).toContainText(
            locale === "de"
              ? "Jetzt geteilt: Alle in der Instanz."
              : "Shared now: Everyone in the instance."
          );
          await expect(memberDialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
          return change;
        },
        (locale, theme, width) =>
          picture(memberPage, testInfo, `narrowing-${locale}-${theme}-${width}`)
      );
      expect(narrowing).toBe(8);
      await memberDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(memberDialog).toBeHidden();
    } else {
      testInfo.annotations.push({
        type: "known-prerequisite",
        description:
          "ui-fix-1: Publish on the draft page is held for a builder whose publish right is on one workspace only; the narrowing dialog was proved through the instance's answer, not in the browser."
      });
    }

    // The admin publishes the audience change: the same revision, now for the workspace.
    await openLiveDialog();
    await question.getByRole("radio", { name: workspaceName, exact: true }).click();
    await expect(dialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
    await dialog.getByRole("button", { name: PUBLISH }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await readApp(page, appUrl, workspaceId)).appAudience.live)
      .toBe("workspace");
    expect((await readApp(page, appUrl, workspaceId)).publishedRevision).toBe(liveRevision);

    // The save line: the agent saves an App in the admin's personal workspace; the line says
    // who can use it now, in the reader's language, and "Share" opens the same dialog.
    await setAccountLocale(page, "en");
    await page.setViewportSize(DESKTOP);
    await setLook(page, "en", "light");
    const personal = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/workspaces/personal`,
      {}
    );
    expect(personal.ok(), await personal.text()).toBe(true);
    const personalId = idSchema.parse(await personal.json()).id;
    await page.goto(`/w/${personalId}`);
    await expect(page).toHaveURL(new RegExp(`/w/${personalId}`, "u"));
    const conversationPath = async () => {
      // The conversation the tool calls run in, to come back to after each look.
      await expect(page).toHaveURL(/\/w\/[^/]+\/c\/[^/?]+/u);
      return new URL(page.url()).pathname;
    };
    const folder = `share-${tag}`;
    const savedTitle = `Share desk ${tag}`;
    const savedId = `share-desk-${tag}`;
    const savedUrl = `${apiBaseUrl}/api/v1/assets/app/${savedId}`;
    for (const [path, content] of Object.entries(plainPageSource)) {
      await sendToolCall(page, "workspace.write_file", { path: `${folder}/${path}`, content });
    }
    // The save moves this tab to the App's draft; the line stays in the conversation.
    const thread = await conversationPath();
    await sendToolCall(page, "workspace.open", { path: folder });
    await sendToolCall(page, "app.save", { path: folder, name: savedTitle });
    const line = page.getByTestId("app-saved-line").last();
    await expect(line).toContainText(`Saved as the app ${savedTitle}.`);
    const saveLines = await eachLook(
      page,
      async (locale) => {
        await page.goto(thread);
        await expect(line).toContainText(
          locale === "de"
            ? `Als App ${savedTitle} gespeichert. Du kannst sie jetzt nutzen, andere, sobald du sie teilst.`
            : `Saved as the app ${savedTitle}. You can use it now; others can once you share it.`
        );
        await expect(line.getByTestId("app-saved-share")).toHaveText(
          locale === "de" ? "Teilen" : "Share"
        );
        return line.getByTestId("app-saved-share");
      },
      (locale, theme, width) => picture(page, testInfo, `save-line-${locale}-${theme}-${width}`)
    );
    expect(saveLines).toBe(8);
    await page.goto(thread);
    await line.getByTestId("app-saved-share").click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(dialog.getByTestId("app-publish-audience")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Only me", exact: true })).toBeChecked();
    // A personal workspace has nobody else in it: the instance offers no workspace choice.
    await expect(dialog.getByTestId("app-publish-audience").getByRole("radio")).toHaveCount(2);
    await expect(dialog.getByRole("radio", { name: "Whole instance", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: PUBLISH })).toBeEnabled();
    await picture(page, testInfo, "save-line-share-dialog-en-light-1280");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();

    // The agent asks to publish the App for the whole instance. Its confirmation asks the person
    // "For whom?" with the agent's suggestion chosen; nothing is live before Allow.
    const notLive = async () => {
      const read = await readApp(page, savedUrl, personalId);
      expect(read.publishedRevision).toBeUndefined();
      expect(read.appAudience.live).toBeUndefined();
    };
    await notLive();
    const composer = page.getByPlaceholder(/^(?:Message|Nachricht)$/u);
    await composer.fill(
      `/tool assets.publish ${JSON.stringify({
        kind: "app",
        name: savedId,
        revision: 1,
        workspaceId: personalId,
        audience: "instance"
      })}`
    );
    await page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u }).click();
    const card = page.getByTestId("tool-decision-card").last();
    const confirmation = card.getByTestId("app-publish-confirmation");
    await expect(confirmation).toBeVisible();
    const agentShots = await eachLook(
      page,
      async (locale) => {
        await page.goto(thread);
        await expect(
          confirmation.getByText(locale === "de" ? "Für wen?" : "For whom?")
        ).toBeVisible();
        await expect(
          confirmation.getByRole("radio", { name: choiceName("instance", locale, ""), exact: true })
        ).toBeChecked();
        await expect(confirmation.getByRole("radio")).toHaveCount(2);
        await expect(card.getByRole("button", { name: ALLOW })).toBeEnabled();
        return confirmation;
      },
      (locale, theme, width) => picture(page, testInfo, `agent-confirm-${locale}-${theme}-${width}`)
    );
    expect(agentShots).toBe(8);
    // Choosing another audience publishes nothing yet: Allow waits for its sentence, and the
    // App is still not live.
    await page.goto(thread);
    await confirmation.getByRole("radio", { name: "Only me", exact: true }).click();
    await expect(confirmation.getByRole("radio", { name: "Only me", exact: true })).toBeChecked();
    await expect(card.getByRole("button", { name: ALLOW })).toBeEnabled();
    await notLive();
    await picture(page, testInfo, "agent-confirm-chosen-en-light-1280");
    // The person's choice is what is published, not the agent's suggestion.
    await card.getByRole("button", { name: ALLOW }).click();
    await expect
      .poll(async () => (await readApp(page, savedUrl, personalId)).appAudience.live, {
        timeout: 60_000
      })
      .toBe("self");
    expect((await readApp(page, savedUrl, personalId)).publishedRevision).toBe(1);
  } finally {
    await setAccountLocale(page, null).catch(() => undefined);
    for (const end of takeBack) await end().catch(() => undefined);
    await memberContext.close();
  }
}
