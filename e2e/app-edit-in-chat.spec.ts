import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import type { Page } from "@playwright/test";
import { apiBaseUrl, signIn } from "./inbox-fixtures";
import { sendToolCall } from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// CHECKOUT-2: "Edit in chat" on an App's draft opens a new conversation of the builder's own
// with the agent that builds, which already holds the App's draft in apps/<name>: a save of
// that folder there is the App's next draft, with no app.edit and no build chat.

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const EDIT_IN_CHAT = /^(?:Edit in chat|Im Chat bearbeiten)$/u;

const html = (title: string, text: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${text}</h1></body></html>`;

/** The App's draft on its page. */
const draftApp = (page: Page) =>
  page
    .getByTestId("app-edit")
    .getByTestId("page-preview-frame")
    .contentFrame()
    .frameLocator("iframe");

/** The German head at 1280 and 390 px; at 390 the action stands in the open "…" menu. */
async function shootGerman(page: Page, label: string, ready: () => Promise<void>) {
  await page.evaluate(() => localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.reload();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 760 });
    await ready();
    const head = page.getByTestId("app-edit");
    const inHead = head.getByRole("button", { name: EDIT_IN_CHAT });
    if (!(await inHead.isVisible())) {
      await head.getByRole("button", { name: "Weitere Aktionen" }).click();
      await expect(page.getByRole("menuitem", { name: EDIT_IN_CHAT })).toBeVisible();
      // The menu fades in: the picture waits until it is fully there.
      await expect(page.getByRole("menu")).toHaveCSS("opacity", "1");
    }
    const screenshot = test.info().outputPath(`${label}-de-${width}.png`);
    await page.screenshot({ path: screenshot });
    await test
      .info()
      .attach(`${label}-de-${width}`, { path: screenshot, contentType: "image/png" });
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.evaluate(() => localStorage.setItem("vivd-catalyst:locale", "en"));
  await page.reload();
}

test("Edit in chat opens a new chat that holds the App's draft and saves it", async ({ page }) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 8);
  const name = `edit-chat-${tag}`;
  const title = `Edit chat ${tag}`;
  await page.setViewportSize({ width: 1280, height: 760 });
  await signIn(page, superadmin);
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  const workspace = page.url();
  await sendToolCall(page, "workspace.write_file", {
    path: `${name}/index.html`,
    content: html(title, "Built in the first chat")
  });
  await sendToolCall(page, "workspace.open", { path: name });
  await sendToolCall(page, "app.save", { path: name, name: title });
  const buildChat = page.url();

  await page.goto(`${workspace}/app-drafts/${name}`);
  const built = () =>
    expect(draftApp(page).getByRole("heading", { name: "Built in the first chat" })).toBeVisible();
  await shootGerman(page, "app-draft-after", built);

  await built();
  await page.getByTestId("app-edit").getByRole("button", { name: EDIT_IN_CHAT }).click();
  // A new conversation in the dock beside the draft.
  const dock = page.locator("[data-dock-chat]");
  await expect(dock).toBeVisible();
  await expect(page).not.toHaveURL(buildChat);
  // The App's files are already in this conversation: changing and saving its folder writes
  // the App's next draft, which the page in front shows.
  const path = `apps/${name}`;
  await sendToolCall(page, "workspace.write_file", {
    path: `${path}/index.html`,
    content: html(title, "Changed in the edit chat")
  });
  await sendToolCall(page, "workspace.open", { path });
  await sendToolCall(page, "app.save", { path, name: title });
  await expect(page.locator('[data-role="assistant"]').last()).not.toContainText("app.edit");
  await page.goto(`${workspace}/app-drafts/${name}`);
  await expect(
    draftApp(page).getByRole("heading", { name: "Changed in the edit chat" })
  ).toBeVisible();
});

test("another builder sees who checked out the draft until a save or 24 hours idle", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ baseURL });
  await pageErrors.watch(context);
  const viewer = await context.newPage();
  try {
    await signIn(page, superadmin);
    await signIn(viewer, { email: "e2e-admin@example.test", password: "e2e-admin-password" });
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name: `Checkout presence ${randomUUID()}` }
    });
    expect(created.ok()).toBe(true);
    const workspace = z.object({ id: z.string() }).parse(await created.json()).id;
    const member = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/workspaces/${workspace}/members`,
      { data: { email: "e2e-admin@example.test" } }
    );
    expect(member.ok()).toBe(true);
    const tag = randomUUID().slice(0, 8);
    const name = `presence-${tag}`;
    const title = `Presence ${tag}`;
    const build = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations`, {
      data: { collaborationWorkspaceId: workspace, visibility: "private" }
    });
    expect(build.ok()).toBe(true);
    const buildId = z.object({ id: z.string() }).parse(await build.json()).id;
    await page.goto(`/w/${workspace}/c/${buildId}`);
    await sendToolCall(page, "workspace.write_file", {
      path: `${name}/index.html`,
      content: html(title, "Shared draft")
    });
    await sendToolCall(page, "workspace.open", { path: name });
    await sendToolCall(page, "app.save", { path: name, name: title });
    await expect(page.getByTestId("app-card")).toContainText(title);
    const draft = `/w/${workspace}/app-drafts/${name}`;
    await page.goto(draft);
    await page.getByTestId("app-edit").getByRole("button", { name: EDIT_IN_CHAT }).click();
    await expect(page.locator("[data-dock-chat]")).toBeVisible();
    await viewer.goto(draft);
    const hint = () =>
      viewer
        .getByTestId("app-edit")
        .getByText(/^(?:Being edited by|Wird bearbeitet von) E2E Superadmin (?:since|seit) /u, {
          exact: false
        });
    // Head text and the action both carry the warning, including in the phone menu.
    for (const locale of ["en", "de"]) {
      for (const width of [1280, 390]) {
        for (const theme of ["light", "dark"]) {
          await viewer.evaluate(
            ([language, scheme]) => {
              localStorage.setItem("vivd-catalyst:locale", language);
              localStorage.setItem("vivd-catalyst:theme", scheme);
            },
            [locale, theme] as const
          );
          await viewer.setViewportSize({ width, height: 760 });
          await viewer.reload();
          await expect(hint().first()).toBeVisible();
          const head = viewer.getByTestId("app-edit");
          const button = head.getByRole("button", {
            name: /(?:Edit in chat|Im Chat bearbeiten) · E2E Superadmin/u
          });
          if (!(await button.isVisible())) {
            await head.getByRole("button", { name: /More actions|Weitere Aktionen/u }).click();
            await expect(
              viewer.getByRole("menuitem", { name: /(?:Edit in chat|Im Chat bearbeiten) · /u })
            ).toBeVisible();
            const bounds = await viewer.getByRole("menu").boundingBox();
            expect(bounds).not.toBeNull();
            if (bounds) {
              expect(bounds.x).toBeGreaterThanOrEqual(0);
              expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
            }
            await viewer.keyboard.press("Escape");
            await expect(viewer.getByRole("menu")).toBeHidden();
          } else {
            await expect(button).toBeVisible();
          }
          const screenshot = test.info().outputPath(`presence-${locale}-${width}-${theme}.png`);
          await viewer.screenshot({ path: screenshot });
          await test.info().attach(`presence-${locale}-${width}-${theme}`, {
            path: screenshot,
            contentType: "image/png"
          });
          await viewer
            .getByTestId("app-edit")
            .evaluate((element) => element.scrollTo(0, element.scrollHeight));
        }
      }
    }
    await viewer.setViewportSize({ width: 1280, height: 400 });
    await expect(hint().first()).toBeVisible();
    await viewer.waitForTimeout(1_000);
    await expect(hint().first()).toBeVisible();
    for (let visit = 0; visit < 2; visit++) {
      await viewer.goto(`/w/${workspace}/apps`);
      await viewer.goto(draft);
      await expect(hint().first()).toBeVisible();
    }
    const sql = postgres(
      process.env.E2E_DATABASE_URL ??
        `postgres://agent_chat:agent_chat@127.0.0.1:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`,
      { max: 1 }
    );
    try {
      await sql`update conversations set updated_at = ${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()} where id in (select conversation_id from asset_checkouts where folder = ${`apps/${name}`})`;
      await viewer.reload();
      await expect(hint()).toHaveCount(0);
      await sql`update conversations set updated_at = ${new Date().toISOString()} where id in (select conversation_id from asset_checkouts where folder = ${`apps/${name}`})`;
      await viewer.reload();
      await expect(hint().first()).toBeVisible();
    } finally {
      await sql.end();
    }
    await sendToolCall(page, "workspace.write_file", {
      path: `apps/${name}/index.html`,
      content: html(title, "Saved draft")
    });
    await sendToolCall(page, "workspace.open", { path: `apps/${name}` });
    await sendToolCall(page, "app.save", { path: `apps/${name}`, name: title });
    // Another tab learns about the save through the App read's 30-second refresh.
    await expect(hint()).toHaveCount(0, { timeout: 40_000 });
    await expect(draftApp(viewer).getByRole("heading", { name: "Saved draft" })).toBeVisible();
  } finally {
    await context.close();
  }
});
