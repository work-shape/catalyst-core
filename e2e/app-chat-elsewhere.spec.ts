import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Page } from "@playwright/test";
import { apiBaseUrl, signIn } from "./inbox-fixtures";
import { sendToolCall } from "./page-surface-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// An App another person built in their own workspace and published for everyone is opened by
// a builder in another workspace. The page head's "Chat" opens the agent that builds about that
// App; the agent reads it, loads its draft with app.edit and saves the change as the next draft.
// Fails without reading the App where it is owned: the conversation stands in the builder's
// workspace, and the read, app.edit and the save were refused as "not available".

const owner = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const builder = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
test.describe.configure({ retries: 0 });

const html = (title: string, text: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${text}</h1></body></html>`;

const idSchema = z.object({ id: z.string() });

/** The App's draft on its page. */
const draftApp = (page: Page) =>
  page
    .getByTestId("app-edit")
    .getByTestId("page-preview-frame")
    .contentFrame()
    .frameLocator("iframe");

test("a builder changes another person's published App from Chat in their own workspace", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 8);
  const name = `elsewhere-${tag}`;
  const title = `Elsewhere ${tag}`;

  // The owner builds the App in a workspace of their own, which the builder is no member of,
  // and publishes it for everyone.
  await signIn(page, owner);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Owner workspace ${tag}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const ownerWorkspace = idSchema.parse(await created.json()).id;
  const build = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations`, {
    data: { collaborationWorkspaceId: ownerWorkspace, visibility: "private" }
  });
  expect(build.ok(), await build.text()).toBe(true);
  await page.goto(`/w/${ownerWorkspace}/c/${idSchema.parse(await build.json()).id}`);
  await sendToolCall(page, "workspace.write_file", {
    path: `${name}/index.html`,
    content: html(title, "Built by the owner")
  });
  await sendToolCall(page, "workspace.open", { path: name });
  await sendToolCall(page, "app.save", { path: name, name: title });
  await expect(page.getByTestId("app-card")).toContainText(title);
  const published = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/assets/app/${name}/publish`,
    { data: { workspaceId: ownerWorkspace, revision: 1, audience: "instance" } }
  );
  expect(published.ok(), await published.text()).toBe(true);

  // The builder opens the App's draft in their own workspace and presses the one "Chat".
  const context = await browser.newContext({ baseURL });
  await pageErrors.watch(context);
  const other = await context.newPage();
  try {
    await other.setViewportSize({ width: 1280, height: 800 });
    await signIn(other, builder);
    await other.goto("/");
    await expect(other).toHaveURL(/\/w\/[^/]+$/u);
    const workspace = other.url();
    expect(workspace).not.toContain(ownerWorkspace);
    await other.goto(`${workspace}/app-drafts/${name}`);
    await expect(
      draftApp(other).getByRole("heading", { name: "Built by the owner" })
    ).toBeVisible();
    const head = other.getByTestId("app-edit");
    await expect(head.getByRole("button", { name: /chat/iu })).toHaveCount(1);
    await head.getByTestId("dock-page-action").click();
    const dockHead = other.getByTestId("dock-head");
    await expect(dockHead).toHaveAttribute("data-subject-kind", "app");
    await expect(dockHead).toContainText(`Working on: ${title}`);

    // Asked for a change, the agent reads the App, loads its draft and saves the change.
    await sendToolCall(other, "platform.assets.get", {});
    await sendToolCall(other, "app.edit", { name });
    // What app.edit opened is the App's draft, never a preview that failed.
    await expect(
      other.getByText(
        /^(?:The preview could not be opened|Die Vorschau konnte nicht geöffnet werden)$/u
      )
    ).toHaveCount(0);
    const path = `apps/${name}`;
    await sendToolCall(other, "workspace.write_file", {
      path: `${path}/index.html`,
      content: html(title, "Changed by the builder")
    });
    await sendToolCall(other, "workspace.open", { path });
    await sendToolCall(other, "app.save", { path, name: title });
    await other.goto(`${workspace}/app-drafts/${name}`);
    await expect(
      draftApp(other).getByRole("heading", { name: "Changed by the builder" })
    ).toBeVisible();
  } finally {
    await context.close();
    // The App is published for everyone, so it would stand in every other spec's App list.
    await page.goto("about:blank");
    const appUrl = `${apiBaseUrl}/api/v1/assets/app/${name}`;
    if ((await page.request.get(`${appUrl}?workspaceId=${ownerWorkspace}`)).ok()) {
      await requestWithOrigin(page, "post", `${appUrl}/delete`, {
        data: {
          workspaceId: ownerWorkspace,
          expectedRevision: await assetRevision(page, `${appUrl}?workspaceId=${ownerWorkspace}`)
        }
      });
    }
  }
});
