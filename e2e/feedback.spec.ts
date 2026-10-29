import { randomUUID } from "node:crypto";
import { type Browser, type FrameLocator, type Page } from "@playwright/test";
import { z } from "zod";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test, type PageErrorWatch } from "./test";

// LU-6: feedback from a published App and on a Workflow's result. The author is a member of the
// workspace that owns the App: the App's `<AppFeedback />` sends their comment, which the
// interface names with the App, and the reviewer reads it in the Inbox. A Workflow's notice in
// the author's Inbox offers "Feedback on this result", sent once; the reviewer reads it beside
// the run. The App's draft offers no form. Fails before LU-6: a comment could only be about an
// agent's answer, and the kit had no form.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const WIDE = { width: 1440, height: 900 };

const reviewer = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** From `tests/fixtures/e2e-users/feedback.yaml`. No other spec uses it. */
const author = { email: "e2e-feedback@example.test", password: "e2e-feedback-password" };

const idSchema = z.object({ id: z.string() });
const runSchema = z.object({ id: z.string(), status: z.string() });

async function sessionOf(
  browser: Browser,
  watch: PageErrorWatch["watch"],
  user: { email: string; password: string }
): Promise<Page> {
  const context = await browser.newContext({ viewport: WIDE });
  await watch(context);
  const page = await context.newPage();
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  return page;
}

function appIn(page: Page, screen: "app-view" | "app-edit"): FrameLocator {
  return page
    .getByTestId(screen)
    .getByTestId("page-preview-frame")
    .contentFrame()
    .frameLocator("iframe");
}

/** A React App whose one page is the kit's feedback form. */
function appSource(id: string, title: string): { path: string; text: string }[] {
  return [
    { path: "app.yaml", text: `id: ${id}\nname: ${title}\nkit: 1.9.0\n` },
    {
      path: "src/routes/__root.tsx",
      text: `import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <main className="flex flex-col gap-4 p-4">
      <Outlet />
    </main>
  )
});
`
    },
    {
      path: "src/routes/index.tsx",
      text: `import { createFileRoute } from "@tanstack/react-router";
import { AppFeedback } from "@work-shape/catalyst-app-kit";

function Index() {
  return (
    <>
      <h1>${title}</h1>
      <AppFeedback />
    </>
  );
}

export const Route = createFileRoute("/")({ component: Index });
`
    }
  ];
}

test("a member's feedback from a published App reaches the reviewer's Inbox, and the draft offers none", async ({
  page,
  browser,
  pageErrors
}) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().slice(0, 8);
  const appId = `feedback-${suffix}`;
  const title = `Offer board ${suffix}`;
  const comment = `The total leaves out the open offers (${suffix}).`;

  await page.setViewportSize(WIDE);
  const root = await sessionOf(browser, pageErrors.watch, reviewer);
  // Signed in once, the author has the account a workspace adds as a member.
  const authorPage = await sessionOf(browser, pageErrors.watch, author);
  expect((await authorPage.request.get(`${apiBaseUrl}/api/v1/me`)).ok()).toBe(true);
  const workspace = await requestWithOrigin(root, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Feedback ${suffix}` }
  });
  expect(workspace.ok(), await workspace.text()).toBe(true);
  const workspaceId = idSchema.parse(await workspace.json()).id;
  const added = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/members`,
    { data: { email: author.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);
  const assetUrl = `${apiBaseUrl}/api/v1/assets/app/${appId}`;
  const saved = await requestWithOrigin(root, "put", assetUrl, {
    data: { workspaceId, expectedRevision: null, files: appSource(appId, title) },
    timeout: 120_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const published = await requestWithOrigin(root, "post", `${assetUrl}/publish`, {
    data: { revision: 1, workspaceId, audience: "workspace" }
  });
  expect(published.ok(), await published.text()).toBe(true);

  // The draft is the builder's; it offers no form, since nobody's feedback is about a draft.
  await root.goto(`/w/${workspaceId}/app-drafts/${appId}`);
  const draft = appIn(root, "app-edit");
  await expect(draft.getByRole("heading", { name: title })).toBeVisible({ timeout: 60_000 });
  await expect(draft.locator('[data-catalyst-feedback="form"]')).toHaveCount(0);

  // The member opens the published App and sends a comment from its form.
  await authorPage.goto(`/w/${workspaceId}/apps/${appId}`);
  const app = appIn(authorPage, "app-view");
  await expect(app.getByRole("heading", { name: title })).toBeVisible({ timeout: 60_000 });
  const form = app.locator('[data-catalyst-feedback="form"]');
  await expect(form).toBeVisible();
  const send = form.getByRole("button", { name: "Send feedback" });
  await expect(send).toBeDisabled();
  await form.getByLabel("Your feedback on this App").fill(comment);
  await send.click();
  const sent = app.locator('[data-catalyst-feedback="sent"]');
  await expect(sent).toContainText("Thank you. Your feedback was sent.");
  await authorPage.screenshot({
    path: test.info().outputPath("evidence-app-feedback-sent.png"),
    animations: "disabled"
  });

  // The reviewer reads it in the Inbox, with the App it is about and a way to it.
  await root.goto("/inbox");
  const row = root.getByTestId("inbox-row").filter({ hasText: comment });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const item = root.getByTestId("inbox-item");
  await expect(item.getByRole("heading", { name: `Feedback on the App ${title}` })).toBeVisible();
  await expect(item).toContainText("From E2E Zz Feedback Author");
  await expect(item).toContainText("Version 1");
  await expect(item.getByTestId("inbox-feedback")).toContainText(comment);
  await expect(item).not.toContainText("did not include the question");
  await root.screenshot({
    path: test.info().outputPath("evidence-app-feedback-inbox.png"),
    animations: "disabled"
  });
  await item.getByRole("link", { name: "Open the App" }).click();
  await expect(root).toHaveURL(new RegExp(`/w/${workspaceId}/apps/${appId}$`, "u"));
});

test("the reader of a Workflow's notice sends feedback on its result once, and the reviewer opens the run", async ({
  page,
  browser,
  pageErrors
}) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().slice(0, 8);
  const workflowId = `feedback-check-${suffix}`;
  const title = `Monthly check ${suffix}`;
  const runAs = `${workflowId}-runner`;
  const noticeTitle = `Check ${suffix} is done`;
  const comment = `Statement 4711 was there after all (${suffix}).`;

  await page.setViewportSize(WIDE);
  const root = await sessionOf(browser, pageErrors.watch, reviewer);
  const authorPage = await sessionOf(browser, pageErrors.watch, author);
  const me = await authorPage.request.get(`${apiBaseUrl}/api/v1/me`);
  expect(me.ok()).toBe(true);
  const authorId = idSchema.parse(await me.json()).id;

  // A Workflow that tells the author it is done, run once.
  const principal = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const assetUrl = `${apiBaseUrl}/api/v1/assets/workflow/${workflowId}`;
  const saved = await requestWithOrigin(root, "put", assetUrl, {
    data: {
      expectedRevision: await assetBaseRevision(root, assetUrl),
      config: {
        name: workflowId,
        manifest: {
          id: workflowId,
          name: title,
          description: "Tells its reader the check is done.",
          runAs,
          inputs: { type: "object", additionalProperties: false, properties: {} },
          outputs: { type: "object", properties: {} },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            {
              id: "tell",
              name: "Tell the reader",
              type: "notify",
              to: { users: [authorId] },
              channels: ["inbox"],
              title: { value: noticeTitle },
              text: { value: "3 findings. Statement 4711 is missing." }
            },
            { id: "result", name: "Result", type: "output", input: {} }
          ]
        }
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const published = await requestWithOrigin(root, "post", `${assetUrl}/publish`, {
    data: { revision: await assetRevision(root, assetUrl) }
  });
  expect(published.ok(), await published.text()).toBe(true);
  const started = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/workflows/${workflowId}/runs`,
    { data: { input: {} } }
  );
  expect(started.ok(), await started.text()).toBe(true);
  const runId = runSchema.parse(await started.json()).id;
  await expect
    .poll(
      async () =>
        runSchema.parse(
          await (await root.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`)).json()
        ).status,
      { timeout: 60_000 }
    )
    .toBe("done");

  // The author opens the notice and comments on the result, once.
  await authorPage.goto("/inbox");
  const noticeRow = authorPage.getByTestId("inbox-row").filter({ hasText: noticeTitle });
  await expect(noticeRow).toBeVisible({ timeout: 30_000 });
  await noticeRow.click();
  const notice = authorPage.getByTestId("inbox-item");
  await notice.getByRole("button", { name: "Feedback on this result" }).click();
  const form = notice.getByTestId("result-feedback-form");
  await form.getByLabel("Your feedback").fill(comment);
  await form.getByRole("button", { name: "Send", exact: true }).click();
  await expect(notice.getByTestId("result-feedback-line")).toContainText("Feedback sent");
  await expect(notice.getByRole("button", { name: "Feedback on this result" })).toHaveCount(0);
  await authorPage.screenshot({
    path: test.info().outputPath("evidence-result-feedback-sent.png"),
    animations: "disabled"
  });
  // Read again, the notice still knows the comment was sent.
  await authorPage.reload();
  await expect(
    authorPage.getByTestId("inbox-item").getByTestId("result-feedback-line")
  ).toContainText("Feedback sent");

  // The reviewer reads it beside the run and opens the run from it.
  await root.goto("/inbox");
  const row = root.getByTestId("inbox-row").filter({ hasText: comment });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const item = root.getByTestId("inbox-item");
  await expect(
    item.getByRole("heading", { name: `Feedback on a result of ${title}` })
  ).toBeVisible();
  await expect(item.getByTestId("inbox-feedback")).toContainText(comment);
  await root.screenshot({
    path: test.info().outputPath("evidence-result-feedback-inbox.png"),
    animations: "disabled"
  });
  await item.getByRole("link", { name: "Open the run" }).click();
  await expect(root).toHaveURL(new RegExp(`/workflows/${workflowId}/runs/${runId}$`, "u"));
  await expect(root.getByTestId("workflow-run-page")).toBeVisible();
});
