import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { signIn } from "./inbox-fixtures";
import { sendToolCall } from "./page-surface-fixtures";
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
