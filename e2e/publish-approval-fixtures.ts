import type { Browser, Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { chooseWorkspaceAudience } from "./app-audience";
import { apiBaseUrl, shoot, signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, type PageErrorWatch } from "./test";

// What the Inbox spec's publish test does beside the Inbox (GR-PUB-1): the member who may
// publish Apps and may not approve a publish, the workspace and App they publish, and their
// Publish, which waits.

/** May write and publish Apps, and may not approve a publish. */
const publisher = {
  email: "e2e-publish-member@example.test",
  password: "e2e-publish-member-password"
};

/** The App the test publishes, named after the attempt: an App's id is taken once. */
interface PublishedApp {
  id: string;
  name: string;
}

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;

/**
 * Writes a person rows that allow these actions on the whole instance, as a role would. No
 * operation grants the rights of an App yet (RIGHTS-1c), and the Apps area offers what the
 * instance-wide rights allow. Answers how to take them back.
 */
export async function allowOnInstance(
  email: string,
  actions: readonly string[]
): Promise<() => Promise<void>> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [user] = await sql<{ id: string }[]>`
      select id from product_users where client_instance_id = 'demo-e2e' and email = ${email}`;
    if (!user) throw new Error(`No person ${email} on the instance`);
    const ids = actions.map((action) => `grant_e2e_${action}_${user.id}`);
    for (const [index, action] of actions.entries()) {
      await sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, scope_id, effect,
           granted_by)
        values
          (${ids[index] ?? ""}, 'demo-e2e', 'user', ${user.id}, ${action}, 'instance', null,
           'allow', 'e2e')`;
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

/** The publisher, signed in on a page of their own: the instance knows them from then on. */
async function publisherPage(
  browser: Browser,
  baseURL: string | undefined,
  pageErrors: PageErrorWatch
): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  await pageErrors.watch(context);
  const page = await context.newPage();
  await signIn(page, publisher);
  return page;
}

const idSchema = z.object({ id: z.string() });
const pointersSchema = z.object({ publishedRevision: z.number().optional() });

/**
 * As the signed-in admin: a new workspace with the publisher in it, and an App of two files
 * there. Answers the workspace and the App's address.
 */
async function writeAppInWorkspace(
  page: Page,
  app: PublishedApp
): Promise<{ workspaceId: string; appUrl: string }> {
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Publish review ${app.id}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const added = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/members`,
    { data: { email: publisher.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);
  const appUrl = `${apiBaseUrl}/api/v1/assets/app/${app.id}`;
  const written = await requestWithOrigin(page, "put", appUrl, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        {
          path: "app.yaml",
          text: `id: ${app.id}\nname: ${app.name}\nkit: 1.1.0\nentry: index.html\n`
        },
        { path: "index.html", text: "<!doctype html><title>Visits</title><p>Visits</p>" }
      ]
    },
    timeout: 90_000
  });
  expect(written.ok(), await written.text()).toBe(true);
  return { workspaceId, appUrl };
}

/** The publisher clicks Publish on the draft: the revision waits, and the page says for whom. */
async function publishAndWait(page: Page, workspaceId: string, app: PublishedApp): Promise<void> {
  await page.goto(`/w/${workspaceId}/app-drafts/${app.id}`);
  const edit = page.getByTestId("app-edit");
  await expect(edit).toContainText("Draft · not published");
  const dialog = page.getByRole("dialog");
  const publish = async () => {
    await edit.getByRole("button", { name: /^(Publish|Veröffentlichen)$/u }).click();
    // Published for the workspace, as before SHARE-1 asked "For whom?".
    await chooseWorkspaceAudience(dialog);
    await dialog.getByRole("button", { name: /^(Publish|Veröffentlichen)$/u }).click();
  };
  await publish();
  // The held publish says so in the dialog it was sent from (SHARE-1), and the live version
  // stays as it is.
  await expect(dialog.getByTestId("app-publish-waits")).toHaveText(
    "Sent for approval. An instance admin decides in the Inbox; until then the live version stays as it is."
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(edit).toContainText("Draft · not published");
  await shoot(page, "gr-pub-1-publish-waits", async () => {
    await expect(edit).toBeVisible();
    await publish();
    await expect(dialog.getByTestId("app-publish-waits")).toBeVisible();
  });
  // Taking pictures leaves the last held dialog open; without them nothing is open.
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
}

/** The revision of the App its users are served, as the admin reads it. */
async function publishedRevisionOf(
  page: Page,
  appUrl: string,
  workspaceId: string
): Promise<number | undefined> {
  const read = await page.request.get(`${appUrl}?workspaceId=${workspaceId}`);
  return pointersSchema.parse(await read.json()).publishedRevision;
}

/** What the publisher's waiting publish left: where it is, and how to clean up after it. */
export interface WaitingPublish {
  app: PublishedApp;
  workspaceId: string;
  appUrl: string;
  /** Takes the publisher's rights back and closes their page. */
  end(): Promise<void>;
}

/**
 * The admin, signed in on `page`, writes an App in a new workspace of the publisher; the
 * publisher, holding the rights to write and publish Apps and not to approve, clicks Publish,
 * and the revision waits.
 */
async function memberPublishesApp(
  page: Page,
  browser: Browser,
  baseURL: string | undefined,
  pageErrors: PageErrorWatch,
  attempt: number
): Promise<WaitingPublish> {
  const app = { id: `publish-review-${attempt}`, name: "Visit report" };
  const memberPage = await publisherPage(browser, baseURL, pageErrors);
  const { workspaceId, appUrl } = await writeAppInWorkspace(page, app);
  const takeBack = await allowOnInstance(publisher.email, ["app.read", "app.write", "app.publish"]);
  const end = async () => {
    await takeBack();
    await memberPage.context().close();
  };
  try {
    await publishAndWait(memberPage, workspaceId, app);
  } catch (error) {
    await end();
    throw error;
  }
  return { app, workspaceId, appUrl, end };
}

/**
 * The admin finds the waiting publish in the Inbox with what it makes live, approves it, and
 * that revision is live.
 */
async function approvePublishInInbox(page: Page, waiting: WaitingPublish): Promise<void> {
  const { app, appUrl, workspaceId } = waiting;
  await page.goto("/inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const row = inbox.getByTestId("inbox-row").filter({ hasText: app.name });
  await expect(row).toContainText("App to publish");
  await row.getByRole("button").click();
  const review = page.getByTestId("publish-review");
  await expect(review.getByTestId("operation-call-headline")).toHaveText(
    `E2E Zz Publish Member wants to publish a new version of the App “${app.name}”.`
  );
  await expect(review.locator('[data-field="version"]')).toContainText("Version 1, the first");
  await expect(review.locator('[data-field="files"]')).toContainText("index.html");
  await shoot(page, "gr-pub-1-inbox-publish", () => expect(review).toBeVisible());
  await page.locator('button[data-decision="approve"]').click();
  await expect(page.getByTestId("inbox-item")).toContainText("Decision by E2E Superadmin");
  await expect.poll(() => publishedRevisionOf(page, appUrl, workspaceId)).toBe(1);
}

/** The published App scenario, kept with the setup and cleanup it owns. */
export async function approveMemberPublish(
  {
    page,
    browser,
    baseURL,
    pageErrors
  }: { page: Page; browser: Browser; baseURL: string | undefined; pageErrors: PageErrorWatch },
  attempt: number
): Promise<void> {
  const waiting = await memberPublishesApp(page, browser, baseURL, pageErrors, attempt);
  try {
    await approvePublishInInbox(page, waiting);
  } finally {
    await waiting.end();
  }
}
