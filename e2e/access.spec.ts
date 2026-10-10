import { expect, test, type Locator, type Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const normalUser = { email: "e2e-user@example.test", password: "e2e-user-password" };
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
const accessPath = "/settings/instance/access";
const assetPath = `${apiBaseUrl}/api/v1/instance/config/assets/agent/kai-helper`;
/** Where a closed Instance page sends the visitor: the workspace, or its first settings page. */
const awayFromInstancePagesPattern = /\/w\/[^/]+$|\/settings\/workspace\/general$/u;
const NARROW = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

function tab(page: Page, name: string): Locator {
  return page.getByRole("tab", { name: new RegExp(`^${name}`, "u") });
}

function checkRow(page: Page, verb: "read" | "write" | "delete"): Locator {
  return page.locator(`[data-testid="check-row"][data-verb="${verb}"]`);
}

async function pick(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option }).click();
}

/** Asks the Check tab what E2E User may do with one agent name. */
async function check(page: Page, assetName: string): Promise<void> {
  await tab(page, "Check").click();
  const person = page.getByRole("button", { name: /^Person: / });
  if ((await person.getAttribute("aria-label")) !== "Person: E2E User") {
    await pick(page, person, /E2E User/u);
  }
  await page.getByLabel("Asset name").fill(assetName);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

test("an administrator registers a Namespace, grants in it, checks, denies, revokes and deletes", async ({
  page
}) => {
  test.setTimeout(90_000);
  // A seeded user is listed once the user has signed in.
  await signInViaApi(page, normalUser);
  expect((await page.request.get(`${apiBaseUrl}/api/v1/me`)).ok()).toBe(true);
  await signInViaApi(page, adminUser);
  await page.setViewportSize(WIDE);
  await page.goto("/settings/instance/users");
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name: "Access", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`${accessPath}$`, "u"));
  await expect(page.getByText("No Namespace yet.")).toBeVisible();

  // Register kai-.
  await page.getByRole("button", { name: "New Namespace" }).click();
  const namespaceDialog = page.getByRole("dialog", { name: "New Namespace" });
  await namespaceDialog.getByLabel("Prefix").fill("Kai");
  await expect(namespaceDialog.getByText("Use lowercase letters and digits")).toBeVisible();
  await namespaceDialog.getByLabel("Prefix").fill("kai-");
  await namespaceDialog.getByLabel("Display name").fill("Kai");
  await namespaceDialog.getByRole("button", { name: "Create Namespace" }).click();
  await expect(namespaceDialog).toBeHidden();
  const namespaceRow = page.getByTestId("namespace-row").filter({ hasText: "kai-" });
  await expect(namespaceRow).toBeVisible();

  // A prefix that overlaps it is refused at the field, before anything is sent.
  await page.getByRole("button", { name: "New Namespace" }).click();
  await namespaceDialog.getByLabel("Prefix").fill("kai-x-");
  await expect(
    namespaceDialog.getByText("This prefix overlaps the registered Namespace kai-.")
  ).toBeVisible();
  await namespaceDialog.getByRole("button", { name: "Cancel" }).click();

  // Grant E2E User writing agents in kai-.
  await tab(page, "Grants").click();
  await expect(page.getByText("No grant yet.")).toBeVisible();
  await page.getByRole("button", { name: "Grant", exact: true }).click();
  const grantDialog = page.getByRole("dialog", { name: "Grant" });
  await pick(page, grantDialog.getByRole("button", { name: /^Person: / }), /E2E User/u);
  await grantDialog.getByLabel("Write").check();
  await pick(page, grantDialog.getByRole("button", { name: /^Namespace: / }), /kai-/u);
  await grantDialog.getByRole("button", { name: "Grant", exact: true }).click();
  await expect(grantDialog).toBeHidden();
  const grantRows = page.getByTestId("grant-row");
  await expect(grantRows).toHaveCount(1);
  await expect(grantRows.first()).toContainText("E2E User");
  await expect(grantRows.first()).toContainText("Write agents");
  await expect(grantRows.first()).toContainText("Namespace kai-");
  await expect(grantRows.first()).toContainText("E2E Admin");

  // The row allows kai-helper and nothing allows other-helper.
  await check(page, "kai-helper");
  await expect(checkRow(page, "write")).toContainText("Allowed");
  await expect(checkRow(page, "write")).toContainText("Grant in Namespace kai-");
  await expect(checkRow(page, "read")).toContainText("Refused");
  await check(page, "other-helper");
  await expect(checkRow(page, "write")).toContainText("Refused");
  await expect(checkRow(page, "write")).toContainText("No grant");

  // The Namespace cannot be deleted while a grant names it, and its row says why.
  await tab(page, "Namespaces").click();
  await namespaceRow.getByRole("button", { name: "Actions for kai-" }).click();
  const deleteItem = page.getByRole("menuitem", { name: /Delete/u });
  await expect(deleteItem).toBeDisabled();
  await deleteItem.hover();
  await expect(
    page.getByText("1 grant names this Namespace. Revoke it first.").first()
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // A deny on the one agent wins over the grant in its Namespace.
  const created = await requestWithOrigin(page, "put", assetPath, {
    data: {
      config: {
        name: "kai-helper",
        displayName: "Kai Helper",
        modelProviderId: "local",
        instructions: "You help Kai.",
        toolNames: []
      }
    }
  });
  expect(created.ok()).toBe(true);
  try {
    await page.reload();
    await tab(page, "Grants").click();
    await page.getByRole("button", { name: "Grant", exact: true }).click();
    await pick(page, grantDialog.getByRole("button", { name: /^Person: / }), /E2E User/u);
    await grantDialog.getByLabel("Write").check();
    await grantDialog.getByRole("radio", { name: /On one asset/u }).check();
    await pick(page, grantDialog.getByRole("button", { name: /^Asset: / }), "kai-helper");
    await grantDialog.getByRole("radio", { name: /^Deny/u }).check();
    await expect(grantDialog.getByText("It is not a wall")).toBeVisible();
    await grantDialog.getByRole("button", { name: "Grant", exact: true }).click();
    await expect(grantDialog).toBeHidden();
    await expect(grantRows).toHaveCount(2);

    await check(page, "kai-helper");
    await expect(checkRow(page, "write")).toContainText("Refused");
    await expect(checkRow(page, "write")).toContainText("Deny on this asset");
    await expect(page.getByText("does not take away instance-wide rights")).toBeVisible();

    // At 390 wide the page keeps inside the window.
    await page.getByRole("button", { name: "Close sidebar" }).click();
    await page.setViewportSize(NARROW);
    await checkRow(page, "write").scrollIntoViewIfNeeded();
    await expect(checkRow(page, "write")).toBeInViewport();
    await expectNoSidewaysScroll(page);
    await page.setViewportSize(WIDE);
    await page.getByRole("button", { name: "Open sidebar" }).click();
  } finally {
    const deleted = await requestWithOrigin(page, "post", `${assetPath}/delete`, { data: {} });
    expect(deleted.ok()).toBe(true);
  }

  // The deny outlives its asset: the list says so and still revokes it.
  await page.reload();
  await tab(page, "Grants").click();
  const orphanedDeny = grantRows.filter({ hasText: "Asset no longer exists" });
  await expect(orphanedDeny).toContainText("kai-helper");
  for (const row of [orphanedDeny, grantRows.filter({ hasText: "Namespace kai-" })]) {
    await row.getByRole("button", { name: /^Actions for the grant of/u }).click();
    await page.getByRole("menuitem", { name: "Revoke" }).click();
    await page
      .getByRole("dialog", { name: "Revoke this grant?" })
      .getByRole("button", { name: "Revoke" })
      .click();
    await expect(row).toHaveCount(0);
  }
  await expect(page.getByText("No grant yet.")).toBeVisible();

  // Nothing names the Namespace any more, so it can go.
  await tab(page, "Namespaces").click();
  await namespaceRow.getByRole("button", { name: "Actions for kai-" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: "Delete Namespace kai-?" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByText("No Namespace yet.")).toBeVisible();
});

test("a user without the right to manage users has no Access page", async ({ page }) => {
  await signInViaApi(page, normalUser);
  await page.goto("/settings/you/profile");
  const rail = page.getByRole("navigation", { name: "Settings pages" });
  await expect(rail.getByRole("button", { name: "Profile" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Access", exact: true })).toHaveCount(0);

  await page.goto(accessPath);
  await expect(page).toHaveURL(awayFromInstancePagesPattern);
  await expect(page.getByRole("tab", { name: /^Namespaces/u })).toHaveCount(0);
});
