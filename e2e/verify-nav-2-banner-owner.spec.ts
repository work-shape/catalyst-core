import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { sendToolCall } from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Verifier (NAV-2, PR 91 round 2): the "Working on" line over the composer leads to the asset's
// page. For an asset a workspace owns, that page must read it where it is, whatever owner Studio
// was last set to; today it says the Data Store does not exist.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const idSchema = z.object({ id: z.string() });

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: superadmin.email, password: superadmin.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test("the Working on line leads to a workspace's Data Store after Studio was set to another owner", async ({
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

  // New data store in the workspace's Studio; the agent's first save opens its draft.
  await page.goto(`/w/${workspaceId}`);
  await page.getByRole("button", { name: "Studio", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Kinds in Studio" })
    .getByRole("button", { name: "Data stores", exact: true })
    .click();
  await page.getByRole("button", { name: /^Scope: / }).click();
  await page.getByRole("option", { name: label }).click();
  await page.getByRole("button", { name: "New data store", exact: true }).click();
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
});
