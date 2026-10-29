import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// LIVE-2 on a Workflow's page: the Workflow adds rows to a Data Store whose draft holds a new
// migration. Its one publish question names the store's migration beside the line on the
// Workflow's own account (LIVE-1), and one click publishes the store, applies the migration and
// makes the Workflow's revision live. Fails without LIVE-2: the question named no store and the
// store stayed at its live level.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const NAME = "Import findings";
const idSchema = z.object({ id: z.string() });
const pointersSchema = z.object({ publishedRevision: z.number().optional() });

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

const storeFiles = (store: string, title: string, withNote: boolean) => [
  { path: "store.yaml", text: `id: ${store}\nname: ${title}\n` },
  {
    path: "migrations/0001_init.sql",
    text: "create table findings (id text primary key, body text not null);\n"
  },
  ...(withNote
    ? [
        {
          path: "migrations/0002_add_note.sql",
          text: "alter table findings add column note text;\n"
        }
      ]
    : [])
];

/** A Workflow without `runAs` that adds rows to the store, as its own account. */
const workflowConfig = (id: string, store: string, description: string) => ({
  name: id,
  manifest: {
    id,
    name: NAME,
    description,
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "store",
        name: "Store",
        type: "operation",
        operation: `data_store.${store}.insert`,
        input: {}
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  }
});

test("one Publish of a Workflow names and applies its store's migration with its account", async ({
  page
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(30_000);
  await signIn(page);
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  const store = `e2e-live2-${tag}`;
  const title = `Findings ${tag}`;
  const id = `live2-walk-${tag}`;
  const storeUrl = `${apiBaseUrl}/api/v1/assets/data_store/${store}`;
  const workflowUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;

  // The store live at level 1, and the Workflow published once on it.
  const put = await requestWithOrigin(page, "put", storeUrl, {
    data: { expectedRevision: null, files: storeFiles(store, title, false) }
  });
  expect(put.ok(), await put.text()).toBe(true);
  try {
    const storePublished = await requestWithOrigin(page, "post", `${storeUrl}/publish`, {
      data: { revision: 1 }
    });
    expect(storePublished.ok(), await storePublished.text()).toBe(true);
    await expect
      .poll(
        async () =>
          (await page.request.get(`${apiBaseUrl}/api/v1/data-stores/${store}/describe`)).status(),
        { timeout: 30_000 }
      )
      .toBe(200);
    const saved = await requestWithOrigin(page, "put", workflowUrl, {
      data: { expectedRevision: null, config: workflowConfig(id, store, "The first draft.") }
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const published = await requestWithOrigin(page, "post", `${workflowUrl}/publish`, {
      data: { revision: 1 }
    });
    expect(published.ok(), await published.text()).toBe(true);

    // The store's draft adds a column; the Workflow's draft changes.
    const drafted = await requestWithOrigin(page, "put", storeUrl, {
      data: { expectedRevision: 1, files: storeFiles(store, title, true) }
    });
    expect(drafted.ok(), await drafted.text()).toBe(true);
    const changed = await requestWithOrigin(page, "put", workflowUrl, {
      data: { expectedRevision: 1, config: workflowConfig(id, store, "The second draft.") }
    });
    expect(changed.ok(), await changed.text()).toBe(true);

    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name: `Live walk ${tag}` }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = idSchema.parse(await created.json()).id;

    await page.goto("/");
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
    await page.goto(`/w/${workspaceId}/workflows/${id}`);
    const workflowPage = page.getByTestId("workflow-page");
    await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(NAME);
    const bar = workflowPage.locator("[data-workflow-draft]");
    await expect(bar).toHaveAttribute("data-workflow-draft", "ahead");

    // One question names the store's migration and the Workflow's own account.
    await bar.getByRole("button", { name: "Publish", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Publish “${NAME}”?` });
    const question = dialog.getByTestId("workflow-publish-question");
    await expect(question).toContainText(
      `Publishes the data store “${title}” first and applies 1 change to its tables: add_note.`
    );
    await expect(question).toContainText(
      `Runs as its own account “${NAME}” and may add rows to ${title}.`
    );

    // One click: the store is published and migrated, then the revision goes live.
    await dialog.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(bar).toHaveCount(0);
    const live = pointersSchema.parse(await (await page.request.get(workflowUrl)).json());
    expect(live.publishedRevision).toBe(2);
    const storeLive = pointersSchema.parse(await (await page.request.get(storeUrl)).json());
    expect(storeLive.publishedRevision).toBe(2);
  } finally {
    // Whatever the test left: the Workflow first, then the store it calls.
    if ((await page.request.get(workflowUrl)).ok()) {
      await requestWithOrigin(page, "post", `${workflowUrl}/delete`, {
        data: { expectedRevision: await assetRevision(page, workflowUrl) }
      });
    }
    await requestWithOrigin(page, "post", `${storeUrl}/delete`, {
      data: { expectedRevision: await assetRevision(page, storeUrl) }
    });
  }
});
