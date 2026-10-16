import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { sendToolCall } from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { shootThemes } from "./surface-shots";
import { expect, test } from "./test";

// The page of an asset a workspace owns reads it where it is, whatever owner Studio was set to
// last: reached by the "Working on" line over the composer, or by its address (NAV-2).

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const idSchema = z.object({ id: z.string() });

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: superadmin.email, password: superadmin.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test("a workspace's Data Store opens from the Working on line and by its address after Studio was set to another owner", async ({
  page
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const tag = randomUUID().slice(0, 6);
  const label = `Team ${tag}`;
  const name = `team-${tag}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: label, defaultConversationVisibility: "private" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;

  // The empty list's offer in the workspace's Studio (it stands in for New there); the agent's
  // first save opens the draft.
  await page.goto(`/w/${workspaceId}`);
  // New goes to the agent where the workspace is the open one.
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(label);
  await page.getByRole("button", { name: "Studio", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Kinds in Studio" })
    .getByRole("button", { name: "Data stores", exact: true })
    .click();
  await page.getByRole("button", { name: /^Scope: / }).click();
  await page.getByRole("option", { name: label }).click();
  await page.getByRole("button", { name: "Build one with the agent", exact: true }).click();
  await sendToolCall(page, "platform.assets.put", {
    kind: "data_store",
    name,
    files: [
      { path: "store.yaml", text: `id: ${name}\nname: Team list ${tag}\n` },
      { path: "migrations/0001_init.sql", text: "create table t (a int);" }
    ]
  });
  await expect(page).toHaveURL((url) => url.pathname === `/build/data-stores/${name}`);
  await expect(page.locator("[data-data-store-publish]")).toBeVisible();

  // Studio is set to the instance, then the person returns to the conversation.
  await page.goto("/build/data-stores");
  await page.getByRole("button", { name: /^Scope: / }).click();
  await page.getByRole("option", { name: "Instance" }).click();
  await expect(page.getByRole("button", { name: "Scope: Instance" })).toBeVisible();
  await page.goto(`/w/${workspaceId}`);
  await page.getByRole("button", { name: "Tool result review" }).first().click();

  // The line over the composer leads to the store's draft, not to "no Data Store".
  await page.getByTestId("conversation-subject").getByRole("link").click();
  await expect(page).toHaveURL((url) => url.pathname === `/build/data-stores/${name}`);
  await expect(page.locator("[data-data-store-publish]")).toBeVisible();

  // The page set Studio to the store's owner, whose list says the store is a draft.
  await page.goto("/build/data-stores");
  await expect(page.getByRole("button", { name: `Scope: ${label}` })).toBeVisible();
  await expect(page.locator("[data-data-store-row-draft]")).toBeVisible();
  // The row's title is read whole beside or above its badges, on a phone and with the dock.
  const row = page
    .getByRole("listitem")
    .filter({ has: page.locator("[data-data-store-row-draft]") });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const title = row.locator("span.truncate").first();
    await expect(title).toBeVisible();
    expect(
      await title.evaluate(
        (element) => element.clientWidth > 0 && element.scrollWidth <= element.clientWidth
      )
    ).toBe(true);
    await shootThemes(page, `nav-2-draft-row-${width}`, async () => {
      await expect(page.locator("[data-data-store-row-draft]")).toBeVisible();
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // By its address, with Studio set to the instance again.
  await page.getByRole("button", { name: /^Scope: / }).click();
  await page.getByRole("option", { name: "Instance" }).click();
  await expect(page.getByRole("button", { name: "Scope: Instance" })).toBeVisible();
  await page.goto(`/build/data-stores/${name}`);
  await expect(page.locator("[data-data-store-publish]")).toBeVisible();
});
