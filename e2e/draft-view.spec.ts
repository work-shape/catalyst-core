import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// DT-1b: what a builder sees of a draft. The head of an App's and a Workflow's draft says what
// a draft's calls do, names the test copy its changes go to and the live version; the publish
// lists each changing call, new or changed; an App's files open as their difference to what is
// live; a test run marks each step with where its call went, and "Run live once" sends one
// step's next call live, after which the next test run goes to the test copy again. Apps And
// Pages check 45, Workflows checks 6 and 7. Fails without DT-1b: the heads named no test copy
// and no live version, nothing was marked new or changed, and no step said where it went.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const idSchema = z.object({ id: z.string() });
const runSchema = z.object({ id: z.string(), status: z.string() });
const rowsSchema = z.object({ rows: z.array(z.unknown()) });

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

/** A Data Store published at level 1 with one table and no rows, waited for until it serves. */
async function liveStore(page: Page, store: string, title: string): Promise<string> {
  const storeUrl = `${apiBaseUrl}/api/v1/assets/data_store/${store}`;
  const put = await requestWithOrigin(page, "put", storeUrl, {
    data: {
      expectedRevision: null,
      files: [
        { path: "store.yaml", text: `id: ${store}\nname: ${title}\n` },
        {
          path: "migrations/0001_init.sql",
          text: "create table findings (id text primary key, body text not null);\n"
        }
      ]
    }
  });
  expect(put.ok(), await put.text()).toBe(true);
  const published = await requestWithOrigin(page, "post", `${storeUrl}/publish`, {
    data: { revision: 1 }
  });
  expect(published.ok(), await published.text()).toBe(true);
  await expect
    .poll(
      async () =>
        (await page.request.get(`${apiBaseUrl}/api/v1/data-stores/${store}/describe`)).status(),
      { timeout: 30_000 }
    )
    .toBe(200);
  return storeUrl;
}

/** The rows of the live store, each as its JSON: the copy's rows never show here. */
async function liveRows(page: Page, store: string): Promise<string[]> {
  const read = await page.request.get(
    `${apiBaseUrl}/api/v1/data-stores/${store}/rows?table=findings`
  );
  expect(read.ok(), await read.text()).toBe(true);
  return rowsSchema.parse(await read.json()).rows.map((row) => JSON.stringify(row));
}

async function workspaceOf(page: Page, name: string): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name }
  });
  expect(created.ok(), await created.text()).toBe(true);
  return idSchema.parse(await created.json()).id;
}

async function inEnglish(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "en");
    window.localStorage.setItem("vivd-catalyst:build-scope", "instance");
  });
}

/** The draft's head at a phone's width, light and dark, as evidence of the check. */
async function shootHead(page: Page, name: string, head: ReturnType<Page["locator"]>) {
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(head).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`evidence-${name}-390-${scheme}.png`),
      animations: "disabled"
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
  if (size) await page.setViewportSize(size);
}

// ------------------------------------------------------------------------------------------
// The App (check 45)

const addFindingSql = `-- @param id text
-- @param body text
insert into findings (id, body)
values ($id, $body)
`;

function appFiles(name: string, store: string, marker: string, withNote: boolean) {
  const actions = [
    { name: "add_finding", file: "actions/add_finding.sql", effect: "changing" },
    ...(withNote ? [{ name: "add_note", file: "actions/add_note.sql", effect: "changing" }] : [])
  ];
  return [
    {
      path: "app.yaml",
      text: JSON.stringify({
        id: name,
        name: "Findings desk",
        kit: "1.1.0",
        entry: "index.html",
        dataStores: [{ name: store, minSchema: 1 }],
        actions
      })
    },
    {
      path: "index.html",
      text: `<!doctype html><title>Findings desk</title>\n<h1>Findings desk</h1>\n<p>${marker}</p>\n`
    },
    { path: "actions/add_finding.sql", text: addFindingSql },
    ...(withNote ? [{ path: "actions/add_note.sql", text: addFindingSql }] : [])
  ];
}

test("an App's draft names its test copy and live version, diffs its files and lists what a publish changes", async ({
  page
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(30_000);
  await signIn(page);
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  const store = `e2e-dt1b-app-${tag}`;
  const title = `Findings ${tag}`;
  const name = `dt1b-app-${tag}`;
  const appUrl = `${apiBaseUrl}/api/v1/assets/app/${name}`;
  const storeUrl = await liveStore(page, store, title);
  const workspaceId = await workspaceOf(page, `Draft view ${tag}`);
  try {
    // Version 1 is live; the draft changes the page and adds a changing action.
    const first = await requestWithOrigin(page, "put", appUrl, {
      data: {
        workspaceId,
        expectedRevision: null,
        files: appFiles(name, store, "live", false)
      }
    });
    expect(first.ok(), await first.text()).toBe(true);
    const published = await requestWithOrigin(page, "post", `${appUrl}/publish`, {
      data: { revision: 1, workspaceId, audience: "workspace" }
    });
    expect(published.ok(), await published.text()).toBe(true);
    const drafted = await requestWithOrigin(page, "put", appUrl, {
      data: { workspaceId, expectedRevision: 1, files: appFiles(name, store, "draft", true) }
    });
    expect(drafted.ok(), await drafted.text()).toBe(true);

    await inEnglish(page);
    await page.goto(`/w/${workspaceId}/app-drafts/${name}`);
    const head = page.getByTestId("app-draft-line");
    await expect(head).toContainText("Draft · reads live data · changes are simulated");
    // The store the draft's changes go to is named, with the way to its test copy.
    const copy = head.locator('[data-draft-test-target="copy"]');
    await expect(copy).toHaveText(`${title}: test copy`);
    await expect(copy).toHaveAttribute("href", new RegExp(`/build/data-stores/${store}$`, "u"));
    await expect(head.locator("[data-draft-live]")).toHaveText(
      /^Live: version 1, published by .+ on .+$/u
    );
    await shootHead(page, "app-draft-head", head);

    // Files: each file against what is live, and a changed one opens as its difference.
    await page.getByRole("button", { name: "Technical details" }).click();
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    const files = page.getByRole("navigation", { name: "Source files" });
    const row = (path: string) => files.getByRole("button").filter({ hasText: path });
    await expect(row("index.html").locator("[data-change-tag]")).toHaveText("Changed");
    await expect(row("actions/add_note.sql").locator("[data-change-tag]")).toHaveText("New");
    await expect(row("actions/add_finding.sql").locator("[data-change-tag]")).toHaveCount(0);
    await row("index.html").click();
    const diff = page.getByTestId("app-file-diff");
    await expect(diff.locator('[data-diff-line="removed"]')).toHaveText(/<p>live<\/p>/u);
    await expect(diff.locator('[data-diff-line="added"]')).toHaveText(/<p>draft<\/p>/u);
    await page.screenshot({
      path: test.info().outputPath("evidence-app-file-diff.png"),
      animations: "disabled"
    });

    // The publish lists the changing action it makes live, marked new.
    await page.getByRole("button", { name: "Publish", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: /^Publish/u });
    // Where the instance's sentence leads, the lists stand under "Details".
    const details = dialog.getByTestId("publish-details").getByRole("button", { name: "Details" });
    if ((await details.count()) > 0) await details.click();
    const changing = dialog.getByTestId("app-publish-changing");
    await expect(changing.locator('[data-change-item="add_note"]')).toContainText("New");
    await expect(changing.locator('[data-change-item="add_finding"]')).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("evidence-app-publish-changes.png"),
      animations: "disabled"
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    if ((await page.request.get(`${appUrl}?workspaceId=${workspaceId}`)).ok()) {
      await requestWithOrigin(page, "post", `${appUrl}/delete`, {
        data: {
          workspaceId,
          expectedRevision: await assetRevision(page, `${appUrl}?workspaceId=${workspaceId}`)
        }
      });
    }
    await requestWithOrigin(page, "post", `${storeUrl}/delete`, {
      data: { expectedRevision: await assetRevision(page, storeUrl) }
    });
  }
});

// ------------------------------------------------------------------------------------------
// The Workflow (checks 6 and 7, and check 45 for its publish)

const WORKFLOW_NAME = "File findings";

function workflowConfig(id: string, store: string, body: string) {
  return {
    name: id,
    manifest: {
      id,
      name: WORKFLOW_NAME,
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "count",
          name: "Count the findings",
          type: "operation",
          operation: `data_store.${store}.query`,
          input: { sql: { value: "select count(*) as n from findings" } }
        },
        {
          id: "add",
          name: "Add the finding",
          type: "operation",
          operation: `data_store.${store}.insert`,
          input: {
            table: { value: "findings" },
            rows: { value: [{ id: "f-1", body }] },
            onConflict: { value: "skip" }
          }
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    }
  };
}

async function ended(page: Page, runId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const read = await page.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`);
        return runSchema.parse(await read.json()).status;
      },
      { timeout: 90_000 }
    )
    .toBe("done");
}

test("a Workflow's test run marks where each call went, and Run live once sends one step live once", async ({
  page
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(30_000);
  await signIn(page);
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  const store = `e2e-dt1b-wf-${tag}`;
  const title = `Findings ${tag}`;
  const id = `dt1b-walk-${tag}`;
  const workflowUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;
  const storeUrl = await liveStore(page, store, title);
  try {
    // Version 1 is live; the draft changes what the changing step writes.
    const saved = await requestWithOrigin(page, "put", workflowUrl, {
      data: { expectedRevision: null, config: workflowConfig(id, store, "first") }
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const published = await requestWithOrigin(page, "post", `${workflowUrl}/publish`, {
      data: { revision: 1 }
    });
    expect(published.ok(), await published.text()).toBe(true);
    const changed = await requestWithOrigin(page, "put", workflowUrl, {
      data: { expectedRevision: 1, config: workflowConfig(id, store, "second") }
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    const workspaceId = await workspaceOf(page, `Draft walk ${tag}`);

    await inEnglish(page);
    const workflowPath = `/w/${workspaceId}/workflows/${id}`;
    await page.goto(workflowPath);
    const workflowPage = page.getByTestId("workflow-page");
    await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(WORKFLOW_NAME);
    const head = workflowPage.locator("[data-workflow-draft]");
    await expect(head).toHaveAttribute("data-workflow-draft", "ahead");
    await expect(head).toContainText("Draft · reads live data · changes are simulated");
    await expect(head.locator('[data-draft-test-target="copy"]')).toHaveText(`${title}: test copy`);
    await expect(head.locator("[data-draft-live]")).toHaveText(/^Live: version 1, published by /u);
    await expect(head.locator("[data-draft-changes]")).toHaveText(
      "Against the live version: 1 changed step."
    );
    await shootHead(page, "workflow-draft-head", head);

    // The publish lists the changing step it makes live, marked changed; the reading one is
    // not listed. Nothing is published here.
    await workflowPage.locator("[data-workflow-publish]").click();
    const publish = page.getByRole("dialog", { name: `Publish “${WORKFLOW_NAME}”?` });
    const details = publish.getByTestId("publish-details").getByRole("button", { name: "Details" });
    if ((await details.count()) > 0) await details.click();
    const changing = publish.getByTestId("workflow-publish-changing");
    await expect(changing.locator('[data-change-item="Add the finding"]')).toContainText("Changed");
    await expect(changing.locator('[data-change-item="Count the findings"]')).toHaveCount(0);
    await publish.getByRole("button", { name: "Cancel", exact: true }).click();

    // Check 6: a test run reads live and writes to the store's test copy, and its canvas says so.
    await head.getByRole("button", { name: "Test run", exact: true }).click();
    const ask = page.getByRole("dialog", { name: `Test “${WORKFLOW_NAME}”?` });
    await ask.getByRole("button", { name: "Start test run", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${workflowPath}/runs/[^/]+$`, "u"));
    const firstRun = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    await ended(page, firstRun);
    const runPage = page.getByTestId("workflow-run-page");
    const targetOf = (step: string) =>
      runPage.locator(`[data-flow-id="${step}"] [data-slot="flow-target"]`);
    await expect(targetOf("count")).toHaveText("Live");
    await expect(targetOf("add")).toHaveText("Test");
    expect(await liveRows(page, store)).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("evidence-test-run-targets.png"),
      animations: "disabled"
    });

    // Check 7: "Run live once" on the changing step sends its next call live, once.
    await runPage.locator('[data-flow-id="add"]').click();
    const panel = page.locator('[data-step-panel="add"]');
    await panel.getByRole("tab", { name: "This run", exact: true }).click();
    const liveOnce = panel.locator("[data-live-once]");
    await liveOnce.getByRole("button", { name: "Run live once", exact: true }).click();
    await expect(liveOnce).toHaveAttribute("data-live-once", "set");
    await expect(liveOnce).toContainText("Runs live in your next test run.");

    const again = async () => {
      const before = page.url();
      await runPage.getByRole("button", { name: "Test again", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Test “${WORKFLOW_NAME}”?` });
      await dialog.getByRole("button", { name: "Start test run", exact: true }).click();
      await expect(page).not.toHaveURL(before);
      const runId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
      await ended(page, runId);
      return runId;
    };
    await again();
    await expect(targetOf("add")).toHaveText("Live");
    expect(await liveRows(page, store)).toEqual([expect.stringContaining("f-1")]);

    // The next test run goes to the test copy again: the switch was used up.
    await again();
    await expect(targetOf("add")).toHaveText("Test");
    expect(await liveRows(page, store)).toEqual([expect.stringContaining("f-1")]);

    // Instance > Operations says where each call went.
    await page.goto("/settings/instance/operations");
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader", { name: "Target" })).toBeVisible();
  } finally {
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
