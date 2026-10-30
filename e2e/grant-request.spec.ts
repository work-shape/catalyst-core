import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { apiBaseUrl, reviewer, signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// AP-3: on Workspace > Members the Owner turns on Builder for a member, which asks for it. An
// instance admin who holds Builder grants the request in the Inbox, and the member's switch
// shows it held. Checked at a phone's width, light and dark.
// The people are in `tests/fixtures/e2e-users/grant-request.yaml`.

const owner = {
  email: "e2e-grant-request-owner@example.test",
  password: "e2e-grant-request-owner-password"
};
const member = {
  email: "e2e-grant-request-member@example.test",
  password: "e2e-grant-request-member-password",
  label: "E2E Zz Grant Request Member"
};
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const idSchema = z.object({ id: z.string() });

async function inEnglish(page: Page): Promise<void> {
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
}

/** The view at a phone's width in both themes, as evidence of the check. */
async function shoot(page: Page, name: string, ready: Locator): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(ready).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`evidence-${name}-390-${scheme}.png`),
      animations: "disabled",
      fullPage: true
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * Opens Workspace > Members for this workspace and returns the member's Builder switch, at a
 * phone's width. The workspace is chosen in the rail, which a wide window shows.
 */
async function openMembers(page: Page, workspace: string): Promise<Locator> {
  await page.setViewportSize(DESKTOP);
  await page.goto("/settings/workspace/members");
  await expect(page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();
  const scope = page.getByRole("button", { name: /^Workspace for these pages: / });
  if ((await scope.count()) > 0 && !(await scope.textContent())?.includes(workspace)) {
    await scope.click();
    await page.getByRole("option", { name: workspace, exact: true }).click();
  }
  await page.setViewportSize(PHONE);
  const row = page
    .getByTestId("collaboration-workspace-member-row")
    .filter({ hasText: member.label });
  await expect(row).toHaveCount(1);
  return row.locator('[data-bundle="builder"]');
}

test("the Owner asks for Builder for a member, and an instance admin grants it", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(PHONE);
  await signIn(page, owner);
  await inEnglish(page);
  const workspace = `E2E Grant ${Date.now()}`;
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: workspace }
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

  // The Owner turns Builder on: that asks for it, and gives nothing yet.
  const builder = await openMembers(page, workspace);
  await expect(builder).toHaveAttribute("data-bundle-state", "none");
  const builderSwitch = builder.getByRole("switch", { name: `Builder for ${member.label}` });
  await builderSwitch.click();
  await expect(builder).toHaveAttribute("data-bundle-state", "requested");
  await expect(builderSwitch).toBeChecked();
  await expect(builder).toContainText("requested");
  const ownRow = page.getByTestId("collaboration-workspace-member-row").first();
  await shoot(page, "grant-request-members-requested", ownRow);

  // An instance admin who holds Builder grants it in the Inbox.
  const context = await browser.newContext({ baseURL, viewport: PHONE });
  await pageErrors.watch(context);
  const admin = await context.newPage();
  await signIn(admin, reviewer);
  await inEnglish(admin);
  await admin.goto("/inbox");
  const row = admin.getByTestId("inbox-row").filter({ hasText: workspace });
  await expect(row).toHaveCount(1);
  await row.getByRole("button").first().click();
  const item = admin.getByTestId("inbox-grant-request");
  await expect(item).toBeVisible();
  await expect(admin.getByTestId("inbox-item")).toContainText(
    `E2E Zz Grant Request Owner asks for Builder for ${member.label} in ${workspace}`
  );
  await shoot(admin, "grant-request-inbox", item);
  await admin.getByRole("button", { name: "Grant", exact: true }).click();
  await expect(admin.getByTestId("inbox-item").locator('[data-status="approved"]')).toBeVisible();
  await context.close();

  // The Owner sees it held, and may take it back.
  await page.reload();
  const held = await openMembers(page, workspace);
  await expect(held).toHaveAttribute("data-bundle-state", "held");
  await expect(held.getByRole("switch")).toBeChecked();
  await expect(held.getByRole("switch")).toBeEnabled();
  await shoot(page, "grant-request-members-held", held);

  const removed = await requestWithOrigin(
    page,
    "delete",
    `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`,
    { data: { confirmName: workspace } }
  );
  expect(removed.ok(), await removed.text()).toBe(true);
});
